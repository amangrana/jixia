# jixia

当前包含 CLI 可行性测试和最小调度器核心，尚无网页界面、HTTP/WebSocket 服务或生产 CLI adapter。设计见 `jixia 设计文档 v1.md`，测试证据见 `jixia CLI 实测记录.md`。

## 运行核心测试

需要 Node 24 或更新版本，利用 Node 原生 TypeScript 类型擦除执行，不需要安装 npm 依赖。

```powershell
node --test tests/scheduler.test.ts tests/routing.test.ts
```

普通安装了 npm 的终端也可以运行 `npm test`。这些测试只调用模拟 bot，不消耗模型额度，使用项目内随机临时目录并在完成后清理。测试包括终止自己创建的测试子进程来模拟崩溃。

## 核心接口

`src/scheduler.ts` 导出 `Scheduler`、`Bot` 等 TypeScript 类型。

- `Scheduler.open(directory, bots)`：打开一个群的数据，恢复未完成轮次；每群只能有一个活跃 writer 实例。没有跨进程锁。
- `enqueue({id, content, targets?})`：入队并持久化；不传 `targets` 时按内容里的 @ 路由（不 @ 或 `@all` 发给所有 bot，`@名字` 只发给被点名的 bot，见 `src/routing.ts`）；相同 ID 和内容的重试不重复入队，ID 携带不同内容则拒绝。
- `remove(id)`：移除仍在排队的消息，并返回调度层确认移除的原文；前端可将它取回输入框。编辑后重新发送必须使用新 ID。
- `moveToTop(id)`：移到待处理队首，不影响当前轮。
- `runUntilIdle()`：开始／等待处理队列。服务调用方在入队后触发；本核心没有后台常驻循环。
- `queue`、`history`：返回快照，不向外暴露可变状态。

一个 bot 失败会记录 failure，另一个继续完成；下一轮等待所有结果落盘。Bot adapter 收到独立的本轮历史快照；永久记忆、compact、结构化记忆请求和进程超时回收尚未接入核心。未来 adapter 需在超时时完成进程树回收后再返回失败。

## 存储选择与限制

最小核心使用每群 `events.jsonl` 作为唯一事实来源，覆盖入队、删除、重排、开始轮次、回答和结束轮次。开始轮次的一条事件同时表达出队与用户消息进入正式历史，避免分别更新 `queue.json` 和聊天 JSONL 的崩溃窗口。事件写入并 sync 后才确认；聊天消息仍有独立连续 seq，队列没有聊天 seq。

设计文档已采用这一方案。核心另外从事件日志派生一份只含聊天消息的 `records.jsonl`，每条带 `seq`、`id`、`ts`，给人和 bot 查看：每次打开时整份重建，之后逐条追加。它不作为状态读回，丢失或损坏不影响数据；写入失败也不影响本轮，下一条消息时重建。

重启时保留已保存的回答，为未完成的 bot 写入“回答中断”，不自动重试；排队消息继续保留，调用 runUntilIdle 后处理。没有换行的未完成日志尾部会修复；其他解析错误阻止加载。存储写入失败后停止继续处理，需重新打开恢复。未提供磁盘配额、日志轮转或多进程写入支持。

CLI 探测脚本在 `tests/cli-*` 中，运行这些脚本会实际调用模型并消耗额度；与核心的模拟测试不同。原始结果保留用于其他 agent 审查，可能包含本机测试路径，但不应保存认证密钥。
