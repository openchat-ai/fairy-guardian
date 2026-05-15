/**
 * FairyGuardian — Process cluster guardian
 *
 * Monitors N child processes via HTTP health checks,
 * auto-revives dead children, bootstraps on first run.
 *
 * Config-driven — no hardcoded ports, paths, or bridge internals.
 */

import { spawn, exec } from 'child_process';

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
    this._heartbeats.set(port, Date.now());
  }

  /** Check all children and revive dead ones */
  async checkAll() {
    const now = Date.now();

    if (this.opts.autoBootstrap && !this._bootstrapped) {
      this._bootstrapped = true;
      await this._bootstrap();
    }

    for (const [port, lastBeat] of this._heartbeats) {
      if (port === this.myPort) continue;
      if (now - lastBeat < this.opts.heartbeatTtl) continue;
      const status = await this._checkStatus(port);
      if (status === 'dead') await this._revive(port);
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

  // ── internals ──

  async _bootstrap() {
    const count = Math.min(this.opts.childCount, this.opts.childNames.length);
    for (let i = 0; i < count; i++) {
      const port = this.childPort(i);
      if (await this._httpPing(port).catch(() => false)) {
        this._log(`cluster alive (${this.childName(i)} :${port}), skip bootstrap`);
        return;
      }
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

  async _httpPing(port) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.opts.pingTimeout);
      const r = await fetch(this._healthUrl(port), { signal: ctrl.signal });
      clearTimeout(t);
      return r.ok;
    } catch { return false; }
  }

  _portListening(port) {
    return new Promise(r => {
      const s = spawn('netstat', ['-ano']);
      let o = '';
      s.stdout.on('data', d => o += d);
      s.on('close', () => r(o.includes(`:${port}`) && o.includes('LISTENING')));
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
        exec(`netstat -ano | findstr :${port}`, (err, stdout) => {
          if (err || !stdout) return r();
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && line.includes('LISTENING')) {
              exec(`taskkill /F /PID ${pid}`, () => r());
              return;
            }
          }
          r();
        });
      } else {
        exec(`fuser -k ${port}/tcp 2>/dev/null`, () => r());
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
