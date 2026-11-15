# jixia

当前可以在浏览器里使用：多个群、@ 路由、消息排队、长期记忆都已接通。还没有自动 compact，一个群聊得太长时会提示上下文过长，需要新开一个群。

## 启动

需要 Node 24 或更新版本，以及已用订阅登录的 Claude Code 和 Codex CLI。

```powershell
npm install
```

```powershell
npm run build
```

```powershell
npm start
```

然后在浏览器里打开 http://127.0.0.1:4517 。`npm run build` 生成网页，只在第一次和改了 `web/` 之后需要运行。

后端只监听 `127.0.0.1`，默认端口 4517。启动时会查询两个 CLI 的登录类型并打印出来；不是订阅登录的 bot 不会启用。配置见 `config.example.yaml`，复制为 `config.yaml` 后修改，没有这个文件时全部用默认值。聊天记录和记忆在 `data/` 下，不进 git。设计见 `jixia 设计文档 v1.md`，测试证据见 `jixia CLI 实测记录.md`。

## 运行核心测试

利用 Node 原生 TypeScript 类型擦除执行，没有编译步骤。运行时依赖只有 `ws` 和 `yaml`。

```powershell
npm test
```

这些测试只调用模拟 bot，不消耗模型额度，使用项目内随机临时目录并在完成后清理。测试包括终止自己创建的测试子进程来模拟崩溃，以及在随机端口上启动真实的 HTTP/WebSocket 服务。

## 网页界面

在 `web/` 下，React 加 Vite；构建结果在 `web/dist`，由后端直接提供，不进 git。

- 左边是群列表和 bot 状态；有回答在进行的群显示转圈，别的群来了新回答显示圆点。
- 不 @ 时所有 bot 回答，`@claude`、`@chatgpt` 只让被点名的回答。Enter 发送，Shift+Enter 换行。
- 当前这轮没结束时可以继续发，消息进入“排队中”，每条可以移到队首、编辑、删除。编辑会把原文追加到输入框里已有草稿的后面，重新发送后排到队尾。
- 发送失败或消息过长时，文字留在输入框里。没发出去的草稿按群保存在浏览器里，刷新不丢。
- 连接断开时顶部有提示，并自动重连；重连后重新拉取当前群的记录和队列。
- 跟随系统的浅色或深色模式。

`web/src/state.ts` 是全部的前端状态规则，不依赖浏览器，测试在 `tests/web-state.test.ts`。

改界面时的两个辅助方式：

```powershell
npm run dev:web
```

带热更新的开发页面，接口转发到正在运行的后端（先 `npm start`）。

```powershell
node tests/ui-mock-server.mjs
```

用脚本化的假 bot 提供同一个界面，不消耗额度，数据在临时目录。消息里带“慢”“很慢”“失败”“记住”“格式”会触发相应的情形，方便查看各种状态。需要先 `npm run build`，然后打开 http://127.0.0.1:4599 。

## 后端服务

入口是 `src/main.ts`；`src/groups.ts` 管理数据目录和各群的调度器，`src/server.ts` 是 HTTP 和 WebSocket。

| 方法和路径 | 作用 |
| --- | --- |
| `GET /api/status` | 各 bot 是否启用、登录类型检查结果 |
| `GET /api/groups` | 群列表 |
| `POST /api/groups` | 新建群，传 `name`；`id` 由后端生成 |
| `GET /api/groups/:id` | 记录尾部（默认最近 200 条，可传 `limit`）、`hasMore`、当前队列、进行中的轮次 |
| `GET /api/groups/:id/records?before=&limit=` | 往前翻更早的记录 |
| `POST /api/groups/:id/messages` | 发送消息，传前端生成的 `id` 和 `content`；返回 202。同一 `id` 同样内容重发不会重复入队 |
| `DELETE /api/groups/:id/queue/:messageId` | 从队列移除并返回原文，删除和编辑都用它 |
| `POST /api/groups/:id/queue/:messageId/top` | 移到队首，返回新队列 |

错误响应是 `{error, code}`。`code` 有：`message-too-long`（413）、`not-queued`（409，消息已开始处理）、`id-reused`（409）、`group-not-found`（404）、`bad-request`（400 或 404）、`forbidden`（403）。

WebSocket 在 `/ws`，后端推送的每条事件是一个 JSON 对象：

- `{group, type: "message", message}`：新的用户消息、回答、失败或系统提示。
- `{group, type: "queue", queue}`：整份队列快照。
- `{group, type: "round", round}`：`round` 为 `{messageId, userSeq, pending}`，一轮结束时为 `null`。
- `{group, type: "error", message}`：这个群处理队列时出错。
- `{type: "groups", groups}`：群列表变了。

连接后不补发历史；前端（重新）连接后调一次 `GET /api/groups/:id`，再应用之后推来的事件。

几条行为：

- **只走订阅。** 启动时查询 `claude auth status --json` 和 `codex login status`。只有报告订阅登录的 CLI 才启用对应的 bot；其他情况下发给它的消息直接记为失败并写明原因。`requireSubscription: false` 可以放行。这只说明启动时 CLI 报告的登录类型，不等于核对过账单。
- **自动重开。** 某个群因为写入错误停止后，下一次对它的请求会重新打开它：未完成的轮次记为“回答中断”，排队消息继续处理。重启后也一样，不需要先发新消息。
- **全局并发。** 所有群同时运行的 CLI 进程不超过 `maxParallelCli`，超出的排队等待。
- **来源检查。** 只接受发往本机地址、且来自本机页面的请求，其他网站的页面无法调用这些接口。

真实检查，使用一次性的数据目录，每次运行发 2 个短请求：

```powershell
node tests/server-live.mjs
```

## 核心接口

`src/scheduler.ts` 导出 `Scheduler`、`Bot` 等 TypeScript 类型。

- `Scheduler.open(directory, bots, {prepare?})`：打开一个群的数据，恢复未完成轮次；每群只能有一个活跃 writer 实例。没有跨进程锁。传入 `prepare` 时，每轮在启动任何 bot 之前调用一次，返回各目标 bot 的 prompt 或拒绝调用的原因；被拒绝的 bot 直接记为失败。
- `enqueue({id, content, targets?})`：入队并持久化；单条消息估算超过 `maxMessageTokens`（默认 3 万）时抛出 `MessageTooLongError`，消息不进队列和历史，前端应把原文留在输入框；不传 `targets` 时按内容里的 @ 路由（不 @ 或 `@all` 发给所有 bot，`@名字` 只发给被点名的 bot，见 `src/routing.ts`）；相同 ID 和内容的重试不重复入队，ID 携带不同内容则拒绝。
- `remove(id)`：移除仍在排队的消息，并返回调度层确认移除的原文；前端可将它取回输入框。编辑后重新发送必须使用新 ID。
- `moveToTop(id)`：移到待处理队首，不影响当前轮。
- `onEvent`：每次变更落盘后回调，事件为 `message`、`queue` 或 `round`；`round` 属性返回进行中的轮次。
- `runUntilIdle()`：开始／等待处理队列。服务调用方在入队后触发；本核心没有后台常驻循环。
- `queue`、`history`：返回快照，不向外暴露可变状态。

一个 bot 失败会记录 failure，另一个继续完成；下一轮等待所有结果落盘。Bot adapter 收到独立的本轮历史快照；永久记忆、compact、结构化记忆请求和进程超时回收尚未接入核心。未来 adapter 需在超时时完成进程树回收后再返回失败。

## CLI adapter

`src/cli.ts` 的 `runCli(config, prompt)` 发起一次全新的 headless 调用：prompt 走 stdin，返回校验过的 `{reply, memoryRequests}`，任何失败都抛出 `CliError`（`kind` 为 `spawn`、`timeout`、`exit` 或 `invalid-output`）。参数按设计文档“实测确定的调用方式”拼装；子进程环境里会去掉会让调用改走 API 计费的变量。

超时后终止整个进程树，再最多等 5 秒宽限期。一次调用最迟在“超时加宽限期”时返回，不会一直挂住本群的队列。失败提示区分两种：进程已确认终止；回收未确认（提示里带 PID，进程可能仍在运行）。CLI 正常退出但它启动的后代进程还占着输出管道时，宽限期后照常使用已得到的回答。

`config` 需要 `provider`（`claude` 或 `codex`）、`workDir`（已存在的空目录）、`readDir`（Claude Code 可读的目录，即 jixia 文件夹）和 `timeoutMs`；可选 `model`、`effort`（仅 Claude Code）、`executable`。

真实调用的检查脚本不在 `npm test` 里，每次运行发 4 个短请求、消耗订阅额度：

```powershell
node tests/cli-live.mjs
```

## 上下文拼装

`src/context.ts` 的 `createPreparer(sources)` 生成调度器用的 `prepare`：每轮把通用指令、公共记忆、各自记忆、摘要读一次，为每个目标 bot 拼好 prompt。各段带标题，顺序固定：通用指令、公共记忆、你的各自记忆、对话摘要、摘要之后的原文、当前用户消息。原文每条消息一行 JSON；“当前用户消息”一段标明本轮可以写公共记忆的 bot。

- 通用指令在 `prompts/system.md`，其中 `{{self}}`、`{{members}}`、`{{records}}` 在拼装时替换。
- 摘要文件以 `---`、`coveredThroughSeq: N`、`---` 三行开头；没有这个文件头时整轮记为失败，不猜测边界。记忆和摘要文件不存在时按空处理。
- 通用指令、公共记忆、摘要读取出错时，本轮所有 bot 记为失败；某个 bot 的各自记忆读取出错时，只有它失败，其他 bot 照常回答。
- 调用前用字数估算 token（中日韩字符算 1 个，其他字符 4 个算 1 个），超过上限（默认 12 万，可传 `maxPromptTokens`）时拒绝调用，不截断。提示会说明是“不算聊天历史就超限”还是“累计聊天历史过长，需要压缩”。后一种在 compact 实现之前没有恢复手段，只能新开一个群。

## 长期记忆写入

bot 可以只返回一段文字，也可以返回 `{reply, memoryRequests}`。`src/memory.ts` 的 `createMemoryWriter(files)` 生成调度器用的 `applyMemory`，逐条处理请求，每条的结果作为一条 `type: "notice"`、`from: "system"` 的消息记进群里，紧跟在该 bot 的回答之后。

- `common` 只接受本轮的写入者（消息只点名一个 bot 时是它，否则是 `defaultWriter`），其他 bot 的请求被拒绝并提示；`self` 写进该 bot 自己的文件。
- 第一版只追加，每条写成一行 `[日期] 内容`，日期由 app 按本地时间加。写入用临时文件加改名；所有群共用一把锁，并行写入不丢条目。
- 写入失败只产生一条提示，不影响 bot 的回答。文件估算超过 `maxMemoryTokens`（默认 8000）时提示整理，不拒绝也不裁剪。
- 同一轮的 bot 看不到本轮写入的记忆（prompt 已提前拼好），下一轮才看到；提示消息会作为 `system` 的发言进入之后的上下文。
- 先写文件、再记提示。两步之间崩溃时记忆已写入但群里少一条提示，以文件为准。

## 真实链路检查

走完整链路的真实检查，包括按用户要求读文件、写文件被拦住和一次真实的记忆写入，每次运行发 10 个短请求：

```powershell
node tests/context-live.mjs
```

## 存储选择与限制

最小核心使用每群 `events.jsonl` 作为唯一事实来源，覆盖入队、删除、重排、开始轮次、回答和结束轮次。开始轮次的一条事件同时表达出队与用户消息进入正式历史，避免分别更新 `queue.json` 和聊天 JSONL 的崩溃窗口。事件写入并 sync 后才确认；聊天消息仍有独立连续 seq，队列没有聊天 seq。

设计文档已采用这一方案。核心另外从事件日志派生一份只含聊天消息的 `records.jsonl`，每条带 `seq`、`id`、`ts`，给人和 bot 查看：每次打开时整份重建，之后逐条追加。它不作为状态读回，丢失或损坏不影响数据；写入失败也不影响本轮，下一条消息时重建。

重启时保留已保存的回答，为未完成的 bot 写入“回答中断”，不自动重试；排队消息继续保留，调用 runUntilIdle 后处理。没有换行的未完成日志尾部会修复；其他解析错误阻止加载。写事件日志的任何一步失败（打开、写入、落盘、关闭）之后，`needsReopen` 变为 true，这个实例的所有调用都会报错，调用方需要重新 `Scheduler.open`：重放磁盘上的事件，未完成的轮次记为“回答中断”，排队消息保留。未提供磁盘配额、日志轮转或多进程写入支持。

CLI 探测脚本在 `tests/cli-*` 中，运行这些脚本会实际调用模型并消耗额度；与核心的模拟测试不同。原始结果保留用于其他 agent 审查，可能包含本机测试路径，但不应保存认证密钥。
