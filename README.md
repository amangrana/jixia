# jixia (稷下)

A local group chat where several AI assistants answer and debate the same question together. Today it puts **Claude (via Claude Code)** and **ChatGPT (via Codex CLI)** in one chat room, with @-routing, a persistent message queue, shared and per-bot long-term memory, and automatic context compaction.

The name comes from the Jixia Academy of ancient China, where scholars of rival schools gathered to debate.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md). The design doc (`jixia 设计文档 v1.md`) and CLI test notes are in Chinese.

## How it works

The browser talks only to a local Node.js backend. The backend routes each message, assembles the prompt (shared history, memory, instructions), and runs each bot as a fresh **headless CLI call** (`claude -p`, `codex exec`) on the user's own subscription. Every CLI exits after one answer, so nothing stays running between turns.

- **@-routing**: no mention or `@all` sends to every bot in parallel; `@claude` / `@chatgpt` sends to one.
- **Debate mode**: tick "discuss" and the bots reply to each other for 1–4 rounds, then summarize.
- **Per-group settings**: model and reasoning effort are chosen per chat room and per bot; web search and session saving are per-room switches shared by both bots.
- **Memory**: a shared memory plus a private memory per bot. Bots *propose* memory writes as a separate structured field; the backend checks which bot may write where, takes a lock, appends the entry, and announces the write in chat. A memory page in the UI lets you view and edit every memory file; saving there backs up the old text and keeps the last 20 backups.
- **Compaction**: when a conversation grows past a token budget, older turns are summarized and the last few rounds are kept verbatim.
- **Quota display**: 5-hour and weekly subscription usage for each CLI, refreshed every 5 minutes without spending quota.

## How it was built

jixia was built by directing AI coding agents (Claude Code and Codex). My part was the requirements and constraints, the design doc, the design decisions and trade-offs, reviewing the agents' work, and the test strategy and acceptance checks. Key decisions:

- **Subscription CLIs, not APIs.** Bots run through the official Claude Code and Codex CLIs on my own subscriptions, so there is no API billing; the trade-off is process management (timeouts, process-tree cleanup, a global concurrency cap). A product version would need to move to the APIs.
- **One-shot headless calls.** Every turn is a fresh CLI call that exits after answering, with history and memory assembled by the backend, instead of long-running CLI sessions. This keeps each bot's context explicit and makes crashes recoverable.
- **Bots read, the backend writes.** Bots can only read files. They *propose* memory writes in a structured field, and the backend validates the target and writes the file, so a bot can never edit another bot's memory or its own instructions.
- **Debate rounds don't write memory.** Only a bot's direct reply to me may propose memory writes, so one bot's guess in a debate can't become a "fact" in long-term memory.
- **Local and single-user.** The server binds to 127.0.0.1 and accepts requests only from local pages; the React front end was chosen so it can later be wrapped in Electron or Tauri.

## Engineering highlights

- **Durable scheduler.** Each chat room has a persistent queue and append-only event log. Messages are idempotent by client-generated ID, a crashed or interrupted round is recovered on restart and recorded as "interrupted", and the queue keeps going. A global limiter caps concurrent CLI processes across rooms.
- **Safe CLI execution.** Bots can read but never write: Codex runs in a read-only sandbox; Claude Code gets only the `Read` tool (plus `WebSearch` and `WebFetch` when the room turns on web search) with MCP disabled. Prompts go through stdin (not the command line) to avoid Windows length limits. Timeouts kill the whole process tree with a bounded grace period, so a hung CLI can never stall a room's queue.
- **Untrusted output handling.** CLI output must match a validated JSON schema (`reply`, `memoryRequests`, ...); anything else is recorded as a failure. The bots' instructions also tell them to treat fetched web pages as reference material and to ignore any instructions inside them; this is a prompt rule, not enforced by code, and the hard guarantee remains that bots cannot write files.
- **Single-instance data lock** with stale-lock takeover, an origin check that only accepts requests from local pages, and a clean exit flow that ends any running CLI processes.
- **Real-time UI.** React + Vite front end over HTTP and WebSocket, with reconnect-and-resync, per-room drafts, an @-mention picker, and a memory editor with optimistic version checks.
- **Tested.** 14 Node test suites run against mock bots (no quota used) and cover the scheduler, routing, CLI adapter, context assembly, memory, compaction, debate rounds, the lock, the HTTP/WebSocket server and front-end state. Separate `*-live.mjs` scripts verify behavior against the real CLIs.

## Running

Requires Windows, Node 24+, and Claude Code and Codex CLI installed and logged in with a subscription. jixia has only been developed and tested on Windows: the Codex call uses Windows sandbox settings and the launcher script is PowerShell.

```powershell
npm install
npm run build
npm start
```

Then open http://127.0.0.1:4517. The server listens on `127.0.0.1` only. To change defaults, copy `config.example.yaml` to `config.yaml` and edit it; without `config.yaml` the defaults are used. `config.yaml`, chat records and memory (under `data/`) are git-ignored.

Only one instance can use a `data/` folder at a time. Use the "Exit" button at the top of the sidebar to quit; closing the browser window does not stop the server.

**Desktop shortcut (optional).** `scripts/start-jixia.ps1` starts jixia in a minimized window if it is not already running, builds the web page when needed, and opens it in a Chrome (or Edge) app window. To create a shortcut, set its target to:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <jixia folder>\scripts\start-jixia.ps1
```

and its icon to `scripts\jixia.ico`.

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
scripts/           desktop launcher and icon
tests/             automated and live test scripts
```

## Notes

jixia is a personal prototype built for my own use. It drives the official Claude Code and Codex CLIs on my own subscriptions; model-list and quota queries use undocumented CLI interfaces that may break when the CLIs update.

## License

[MIT](LICENSE)
