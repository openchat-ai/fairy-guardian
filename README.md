# fairy-guardian · 仙女守护者 · Self-Healing Cluster SDK

> Run 3 Ollama instances, 2 vLLM servers, or any HTTP service — auto-restart on crash. Zero dependencies. 5 lines of JS.
>
> 一行代码拉起自愈集群。Ollama / vLLM / 任意 HTTP 服务，崩溃自动复活。零依赖，14KB。

**Zero dependencies.** Uses only Node.js built-ins. No daemon, no config files, no Docker.

---

## Why · 为什么用这个

You're running LLM servers locally. Ollama OOMs. vLLM crashes under load. Your embedding service randomly dies.

Options:

| Tool | Problem |
|---|---|
| PM2 | Heavy, complex config, overkill for 3 processes |
| Docker restart policy | Slow, hurts GPU sharing, 200MB+ overhead |
| systemd | Linux-only, unit files everywhere |
| **fairy-guardian** | `npm install` → 5 lines → done. 14KB. |

---

## Install · 安装

```bash
npm install fairy-guardian
```

## Quick Start · 快速开始

### Ollama 模型集群

```js
import { FairyGuardian } from 'fairy-guardian';

const models = ['llama3.1:8b', 'mistral:7b', 'codellama:13b'];

new FairyGuardian({
  myPort: 11434,
  childCount: 3,
  childNames: models,
  portOffset: 100,  // 11444, 11544, 11644
  healthPath: '/api/tags',
  spawnCmd: (port, _, i) => ['OLLAMA_HOST=0.0.0.0:' + port, 'ollama', 'serve'],
});

setInterval(() => guardian.checkAll(), 30000);
// 崩了就拉起来，模型服务永不间断
```

### vLLM 多模型推理

```js
new FairyGuardian({
  myPort: 8000,
  childNames: ['llama-70b', 'qwen-72b', 'mixtral-8x7b'],
  portOffset: 100,
  healthPath: '/health',
  spawnCmd: (port) => [
    'python', '-m', 'vllm.entrypoints.api_server',
    `--port=${port}`, '--model=mistralai/Mixtral-8x7B'
  ],
});

setInterval(() => guardian.checkAll(), 30000);
```

### Embedding / Reranker 服务

```js
new FairyGuardian({
  myPort: 8080,
  childNames: ['bge-m3', 'bge-reranker-v2'],
  portOffset: 50,
  healthPath: '/health',
  spawnCmd: (port) => ['python', 'server.py', `--port=${port}`],
});
```

---

## API

### `new FairyGuardian(opts)`

| Option · 参数 | Type · 类型 | Default · 默认 | Description · 说明 |
|---|---|---|---|
| `myPort` | `number` | **required** | Base port for child calculation · 主端口 |
| `childCount` | `number` | `6` | Number of children · 子进程数量 |
| `portOffset` | `number` | `10` | Child port = `myPort + (i+1) × offset` |
| `childPort(i, myPort)` | `function` | — | Custom port fn (overrides `portOffset`) |
| `childNames` | `string[]` | auto | Display names · 显示名称 |
| `spawnCmd(port)` | `function` | required | Returns `[cmd, ...args]` · 启动命令 |
| `cwd` | `string` | `cwd` | Working directory · 工作目录 |
| `spawnDelay` | `number` | `2000` | ms between spawns · 间隔 |
| `healthHost` | `string` | `'localhost'` | Health check host · 健康检查地址 |
| `healthPath` | `string` | `'/health'` | Health endpoint · 健康检查路径 |
| `pingTimeout` | `number` | `3000` | Ping timeout (ms) · 超时 |
| `heartbeatTtl` | `number` | `30000` | Dead after no heartbeat · 无心跳判定死亡 |
| `reviveCooldown` | `number` | `300000` | Min ms between revives · 复活冷却 |
| `maxRevives` | `number` | `3` | Max revives per child · 最多复活次数 |
| `autoBootstrap` | `boolean` | `true` | Auto-spawn on first check · 首次自动拉起 |
| `logPrefix` | `string` | `'[Guardian]'` | Log prefix · 日志前缀 |
| `onBootstrap(port, name, i)` | `function` | — | Before initial spawn · 初始拉起回调 |
| `onRevive(port, name, n)` | `function` | — | Before revive spawn · 复活回调 |

### `guardian.checkAll()`

Check all children. Bootstrap on first run. Revive dead ones.

检查所有子进程。首次拉起集群。复活死掉的。

```js
await guardian.checkAll();
```

### `guardian.receiveHeartbeat(port)`

Record child heartbeat. Useful for active-reporting children.

记录子进程心跳。

### `guardian.destroy()`

Clean up all state. No more operations after this.

清理所有状态，之后不能再做任何操作。

```js
guardian.destroy();
```

### `guardian.status()`

Snapshot of all children · 子进程快照。

```js
console.log(guardian.status());
// { 11544: { name: 'mistral:7b', alive: true, reviveCount: 0 }, ... }
```

### `guardian.rollingRestart()`

Restart all children one by one, waiting for each to become healthy before moving to the next. Zero downtime — at least N-1 instances serving at all times.

逐个重启所有子进程，每个等健康再切下一个。零宕机 — 始终有 N-1 个实例可用。

```js
await guardian.rollingRestart();
// [Guardian] rolling restart: 3 children
// [Guardian]   restarting llama3.1:8b :11444...
// [Guardian]   llama3.1:8b :11444 ready
// [Guardian]   restarting mistral:7b :11544...
// [Guardian]   mistral:7b :11544 ready
// [Guardian]   restarting codellama:13b :11644...
// [Guardian]   codellama:13b :11644 ready
```

---

## How It Works · 工作原理

```
┌──────────────┐   crashes (OOM)    ┌──────────────┐
│  llama3.1:8b │ ───────────────→   │              │
│  :11444       │                   │  Guardian    │
└──────────────┘                    │              │
                            revive  │  checkAll()  │
┌──────────────┐   crashes (OOM)    │  every 30s   │
│  mistral:7b   │ ───────────────→  │              │
│  :11544       │                   └──────────────┘
└──────────────┘

1. Bootstrap · 自举 — first checkAll() spawns all children
2. Ping · 探活 — HTTP GET /health on each child
3. Revive · 复活 — dead child → spawn replacement
4. Re-entry safe · 防重复 — skips if port already alive
```

---

Part of **[OpenChat](https://github.com/openchat-ai/openchat)** — decentralized AI resident platform · 去中心化 AI 居民平台
