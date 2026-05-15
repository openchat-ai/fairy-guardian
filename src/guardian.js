/**
 * FairyGuardian — Process cluster guardian
 *
 * Monitors N child processes via HTTP health checks,
 * auto-revives dead children, bootstraps on first run.
 *
 * Config-driven — no hardcoded ports, paths, or bridge internals.
 */

import { spawn } from 'child_process';

export class FairyGuardian {
  /**
   * @param {Object} opts
   * @param {number} opts.myPort          - own port, used as base for child ports
   * @param {number} [opts.childCount=6]  - number of children to manage
   * @param {number} [opts.portOffset=10] - child port = myPort + (i+1) * portOffset
   * @param {function} [opts.childPort]   - custom port fn: (i, myPort) => port. Overrides portOffset.
   * @param {function} [opts.childName]   - custom name fn: (i) => string. Default: 'child-{i+1}'
   * @param {string[]} [opts.childNames]  - static name array, index-mapped
   *
   * @param {string[]} [opts.spawnCmd]    - spawn args array fn: (port, i) => string[]. Default uses process.execPath
   * @param {string} [opts.cwd]           - working directory for spawn, default process.cwd()
   * @param {number} [opts.spawnDelay=2000] - ms delay between sequential spawns
   *
   * @param {string} [opts.healthHost='localhost']
   * @param {string} [opts.healthPath='/health']
   * @param {number} [opts.pingTimeout=3000]
   * @param {number} [opts.heartbeatTtl=30000]     - ms without heartbeat → possibly dead
   * @param {number} [opts.reviveCooldown=300000]  - ms between revive attempts on same child
   * @param {number} [opts.maxRevives=3]           - max revive attempts per child
   *
   * @param {boolean} [opts.autoBootstrap=true]    - spawn children on first checkAll
   * @param {string} [opts.logPrefix='[Guardian]']
   * @param {function} [opts.onBootstrap]          - (port, name, index) => void, called before each spawn
   * @param {function} [opts.onRevive]             - (port, name, attempt) => void, called before revive
   */
  constructor(opts = {}) {
    this.opts = Object.assign({
      myPort: 0,
      childCount: 6,
      portOffset: 10,
      spawnDelay: 2000,
      healthHost: 'localhost',
      healthPath: '/health',
      pingTimeout: 3000,
      heartbeatTtl: 30000,
      reviveCooldown: 300000,
      maxRevives: 3,
      autoBootstrap: true,
      logPrefix: '[Guardian]',
      cwd: process.cwd(),
    }, opts);

    if (!this.opts.spawnCmd) {
      this.opts.spawnCmd = (port) => [process.execPath, 'app.js', `--port=${port}`];
    }
    if (!this.opts.childNames) {
      this.opts.childNames = Array.from({ length: this.opts.childCount }, (_, i) => `child-${i + 1}`);
    }

    this.myPort = this.opts.myPort;
    this._heartbeats = new Map();
    this._reviveCount = new Map();
    this._lastRestarts = new Map();
    this._bootstrapped = false;
    this._checking = false;
    this._destroyed = false;
    this._netstatCache = null;
    this._netstatCacheTime = 0;
  }

  /** @returns {number} child port for index i */
  childPort(i) {
    if (this.opts.childPort) return this.opts.childPort(i, this.myPort);
    return this.myPort + (i + 1) * this.opts.portOffset;
  }

  /** @returns {string} child name for index i */
  childName(i) {
    return this.opts.childNames[i] || this.opts.childName?.(i) || `child-${i + 1}`;
  }

  /** @returns {string} health URL for a child port */
  _healthUrl(port) {
    return `http://${this.opts.healthHost}:${port}${this.opts.healthPath}`;
  }

  // ── public API ──

  /** Process a heartbeat from a child */
  receiveHeartbeat(port) {
    if (this._destroyed) return;
    this._heartbeats.set(port, Date.now());
  }

  /** Check all children and revive dead ones */
  async checkAll() {
    if (this._destroyed || this._checking) return;
    this._checking = true;
    try {
      const now = Date.now();

      if (this.opts.autoBootstrap && !this._bootstrapped) {
        this._bootstrapped = true;
        await this._bootstrap();
      }

      const stale = [];
      for (const [port, lastBeat] of this._heartbeats) {
        if (port === this.myPort) continue;
        const age = now - lastBeat;
        const rc = this._reviveCount.get(port) || 0;

        // Cleanup: permanently dead (max revives exceeded + silent > 10 min)
        if (rc >= this.opts.maxRevives && age > this.opts.reviveCooldown) {
          stale.push(port);
          continue;
        }
        // Cleanup: ghost entry (no heartbeat for 5x TTL)
        if (age > this.opts.heartbeatTtl * 5) {
          stale.push(port);
          continue;
        }

        if (age < this.opts.heartbeatTtl) continue;
        const status = await this._checkStatus(port);
        if (status === 'dead') await this._revive(port);
      }

      for (const port of stale) {
        this._log(`cleanup stale: ${this._childNameForPort(port) || port}`);
        this._heartbeats.delete(port);
        this._reviveCount.delete(port);
        this._lastRestarts.delete(port);
      }
    } finally {
      this._checking = false;
    }
  }

  /** Get child status snapshot */
  status() {
    const now = Date.now();
    const result = {};
    for (const [port, lastBeat] of this._heartbeats) {
      result[port] = {
        name: this._childNameForPort(port),
        alive: (now - lastBeat) < this.opts.heartbeatTtl,
        reviveCount: this._reviveCount.get(port) || 0,
      };
    }
    return result;
  }

  /** Rolling restart — one by one, wait for health before next. Zero downtime. */
  async rollingRestart() {
    if (this._destroyed) return { ok: false, restarted: 0 };
    const ports = [...this._heartbeats.keys()];
    if (ports.length === 0) {
      this._log('no children to restart');
      return { ok: true, restarted: 0 };
    }

    this._log(`rolling restart: ${ports.length} children`);
    for (const port of ports) {
      const name = this._childNameForPort(port) || `:${port}`;
      this._log(`  restarting ${name} :${port}...`);

      // Kill old process on this port
      await this._killPort(port);
      await this._delay(1000);

      // Spawn new process
      this._spawn(port);
      await this._delay(2000);

      // Wait for healthy
      let healthy = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        if (await this._httpPing(port).catch(() => false)) {
          healthy = true;
          break;
        }
        await this._delay(2000);
      }

      if (healthy) {
        this._log(`  ${name} :${port} ready`);
      } else {
        this._log(`  ${name} :${port} failed to become healthy`);
      }
    }

    return { ok: true, restarted: ports.length };
  }

  /** Clean up all state. No more operations after this. */
  destroy() {
    this._destroyed = true;
    this._heartbeats.clear();
    this._reviveCount.clear();
    this._lastRestarts.clear();
    this._netstatCache = null;
    this._log('destroyed');
  }

  // ── internals ──

  async _bootstrap() {
    const count = Math.min(this.opts.childCount, this.opts.childNames.length);
    // Parallel check — any alive → skip
    const checks = [];
    for (let i = 0; i < count; i++) {
      const port = this.childPort(i);
      checks.push((async () => {
        return await this._httpPing(port, 1500).catch(() => false);
      })());
    }
    const results = await Promise.all(checks);
    if (results.some(Boolean)) {
      const firstAlive = results.findIndex(Boolean);
      this._log(`cluster alive (${this.childName(firstAlive)} :${this.childPort(firstAlive)}), skip bootstrap`);
      return;
    }

    for (let i = 0; i < count; i++) {
      const port = this.childPort(i);
      const name = this.childName(i);
      this._log(`bootstrap: ${name} :${port}`);
      this.opts.onBootstrap?.(port, name, i);
      this._spawn(port);
      await this._delay(this.opts.spawnDelay);
    }
  }

  async _checkStatus(port) {
    const httpAlive = await this._httpPing(port);
    if (httpAlive) return 'alive';
    const listening = await this._portListening(port);
    return listening ? 'busy' : 'dead';
  }

  async _revive(port) {
    const c = this._reviveCount.get(port) || 0;
    if (c >= this.opts.maxRevives) return;
    const last = this._lastRestarts.get(port) || 0;
    if (Date.now() - last < this.opts.reviveCooldown) return;
    const name = this._childNameForPort(port) || '';
    this._log(`revive ${name} :${port} (attempt ${c + 1}/${this.opts.maxRevives})`);
    this.opts.onRevive?.(port, name, c + 1);
    this._spawn(port);
    this._lastRestarts.set(port, Date.now());
    this._reviveCount.set(port, c + 1);
  }

  _spawn(port) {
    const cmd = this.opts.spawnCmd(port, this.myPort);
    spawn(cmd[0], cmd.slice(1), {
      cwd: this.opts.cwd, detached: true, stdio: 'ignore'
    }).unref();
  }

  async _httpPing(port, timeoutOverride) {
    try {
      const ctrl = new AbortController();
      const ms = timeoutOverride || this.opts.pingTimeout;
      const t = setTimeout(() => ctrl.abort(), ms);
      const r = await fetch(this._healthUrl(port), { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch { return false; }
  }

  _portListening(port) {
    const cacheTtl = 10000;
    if (this._netstatCache && (Date.now() - this._netstatCacheTime) < cacheTtl) {
      return this._netstatCache.includes(`:${port}`) && this._netstatCache.includes('LISTENING');
    }
    return new Promise(r => {
      const s = spawn('netstat', ['-ano']);
      let o = '';
      s.stdout.on('data', d => o += d);
      s.on('close', () => {
        this._netstatCache = o;
        this._netstatCacheTime = Date.now();
        r(o.includes(`:${port}`) && o.includes('LISTENING'));
      });
      s.on('error', () => r(false));
    });
  }

  _childNameForPort(port) {
    for (let i = 0; i < this.opts.childNames.length; i++) {
      if (this.childPort(i) === port) return this.childName(i);
    }
    return null;
  }

  _killPort(port) {
    return new Promise(r => {
      if (process.platform === 'win32') {
        const netstat = spawn('netstat', ['-ano']);
        let o = '';
        netstat.stdout.on('data', d => o += d);
        netstat.on('close', () => {
          for (const line of o.split('\n')) {
            if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (!pid) continue;
            spawn('taskkill', ['/F', '/PID', pid]).on('close', () => r());
            return;
          }
          r();
        });
        netstat.on('error', () => r());
      } else {
        spawn('fuser', ['-k', `${port}/tcp`]).on('close', () => r());
      }
    });
  }

  _log(msg) {
    console.log(`${this.opts.logPrefix} ${msg}`);
  }

  _delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

export default FairyGuardian;
