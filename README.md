# jixia (稷下)

A local group chat where several AI assistants answer and debate the same question together. Today it puts **Claude (via Claude Code)** and **ChatGPT (via Codex CLI)** in one chat room, with @-routing, a persistent message queue, shared and per-bot long-term memory, and automatic context compaction.

The name comes from the Jixia Academy of ancient China, where scholars of rival schools gathered to debate.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md). The design doc (`jixia 设计文档 v1.md`) and CLI test notes are in Chinese.

## How it works

The browser talks only to a local Node.js backend. The backend routes each message, assembles the prompt (shared history, memory, instructions), and runs each bot as a fresh **headless CLI call** (`claude -p`, `codex exec`) on the user's own subscription. Every CLI exits after one answer, so nothing stays running between turns.

- **@-routing**: no mention or `@all` sends to every bot in parallel; `@claude` / `@chatgpt` sends to one.
- **Debate mode**: tick "discuss" and the bots reply to each other for 1–4 rounds, then summarize.
- **Per-group settings**: model, reasoning effort, web search and session saving, chosen per chat room and per bot.
- **Memory**: a shared memory plus a private memory per bot. Bots *propose* memory writes as a separate structured field; the backend validates the target, takes a lock, writes the file, keeps the last 20 versions, and announces the write in chat.
- **Compaction**: when a conversation grows past a token budget, older turns are summarized and the last few rounds are kept verbatim.
- **Quota display**: 5-hour and weekly subscription usage for each CLI, refreshed every 5 minutes without spending quota.

## Engineering highlights

- **Durable scheduler.** Each chat room has a persistent queue and append-only event log. Messages are idempotent by client-generated ID, a crashed or interrupted round is recovered on restart and recorded as "interrupted", and the queue keeps going. A global limiter caps concurrent CLI processes across rooms.
- **Safe CLI execution.** Bots can read but never write: Codex runs in a read-only sandbox; Claude Code gets only the `Read` tool with MCP disabled. Prompts go through stdin (not the command line) to avoid Windows length limits. Timeouts kill the whole process tree with a bounded grace period, so a hung CLI can never stall a room's queue.
- **Untrusted output handling.** CLI output must match a validated JSON schema (`reply`, `memoryRequests`, ...); anything else is recorded as a failure. Web content fetched during search is treated as data, not instructions.
- **Single-instance data lock** with stale-lock takeover, an origin check that only accepts requests from local pages, and a clean exit flow that ends any running CLI processes.
- **Real-time UI.** React + Vite front end over HTTP and WebSocket, with reconnect-and-resync, per-room drafts, an @-mention picker, and a memory editor with optimistic version checks.
- **Tested.** 14 Node test suites run against mock bots (no quota used) and cover the scheduler, routing, CLI adapter, context assembly, memory, compaction, debate rounds, the lock, the HTTP/WebSocket server and front-end state. Separate `*-live.mjs` scripts verify behavior against the real CLIs.

## Running

Requires Node 24+, and Claude Code and Codex CLI installed and logged in with a subscription.

```powershell
npm install
npm run build
npm start
```

Then open http://127.0.0.1:4517. The server listens on `127.0.0.1` only. Copy `config.example.yaml` to `config.yaml` to change defaults. Chat records and memory are stored under `data/` and are git-ignored.

```powershell
npm test   # mock bots only, no quota used
```

## Project layout

```text
src/scheduler.ts   per-room queue, rounds, recovery
src/cli.ts         headless Claude Code / Codex calls
src/context.ts     prompt assembly; src/compact.ts compaction
src/memory.ts      shared and per-bot memory
src/server.ts      HTTP + WebSocket API
src/quota.ts, src/models.ts  subscription usage and model lists
web/               React front end
prompts/           system, debate and compaction instructions
tests/             automated and live test scripts
```

## Notes

jixia is a personal prototype built for my own use. It drives the official Claude Code and Codex CLIs on my own subscriptions; model-list and quota queries use undocumented CLI interfaces that may break when the CLIs update.

## License

[MIT](LICENSE)
