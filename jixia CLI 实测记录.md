# jixia CLI 实测记录

测试日期：2026-11-14（America/Toronto）

用途：向文档作者 AI 和其他 agent 分享实际测试结果，避免将推测写成已验证结论。本文根据当前聊天中的用户终端输出与 reviewer 实际工具执行输出整理；不是完整原始日志归档。后续测试继续更新本文。

## 环境与证据来源

| 环境 | Node / npm | Codex | Claude Code |
| --- | --- | --- | --- |
| 用户 PowerShell 终端 | 用户报告 Node `v26.13.1`、npm `11.20.0` | `0.169.0` | `2.1.325` |
| reviewer 的 Codex 执行环境 | Codex 自带 Node `v24.22.1` | `0.169.0-alpha.11.1` | `2.1.325` |

两套环境不可视为相同。最初 reviewer 能找到的 Node 是 Codex 自带运行时，不代表用户终端已安装 Node；用户随后安装并验证了独立 Node。

未记录邮箱、认证令牌或认证文件内容。

## 测试结果

### T01：订阅登录状态

来源：用户终端输出；reviewer 也检查过自己的执行环境。

```powershell
claude auth status --text
codex login status
```

- Claude 返回 `Login method: Claude Pro account`。
- Codex 返回 `Logged in using ChatGPT`。
- 结论：当前 CLI 登录状态使用订阅账号。
- 限制：尚未通过专门的子进程环境清理实验排除 API key、第三方 provider 等覆盖因素；未独立核对实际账单。不能仅凭登录状态证明所有未来调用都必然走订阅。

### T02：短中文 stdin 与进程退出

来源：用户终端；两个 CLI 均通过。

```powershell
'请不要使用任何工具，只回复：中文测试成功' | claude -p
'请不要使用任何工具，只回复：中文测试成功' | codex exec --skip-git-repo-check --sandbox read-only -
```

两者正确返回“中文测试成功”，然后回到 PowerShell 提示符。Codex 会打印启动信息、输入回显与 token 使用信息；不能把整段终端输出直接当成最终回答。

### T03：长中文 stdin

来源：用户终端；两个 CLI 均通过。

- 在 PowerShell 内存变量中生成 52,107 字符输入，包括重复中文填充内容及首尾随机 GUID。
- 输入通过管道分别交给 `claude -p` 和 `codex exec ... -`。
- 两者返回的首尾 GUID 均与预期完全一致。
- Codex 报告 `tokens used 39,684`，且回显了长输入。
- 测试变量本身没有生成文档或数据文件；普通 CLI 调用仍可能按默认设置保存会话记录。
- 结论：已验证该长度中文输入可以通过 stdin 传入，未观察到首尾截断或中文乱码。
- 限制：首尾抽查不证明中间每个字符完整；重复填充不代表真实聊天的全部复杂情况。token 数不能直接换算为订阅额度或现金收费。

### T04：Codex 忽略用户配置后调用

来源：用户终端，Codex `0.169.0`；通过。

```powershell
'请不要使用任何工具，只回复：配置隔离调用成功' | codex exec --ignore-user-config --skip-git-repo-check --sandbox read-only -
```

正确返回“配置隔离调用成功”。

限制：只验证忽略用户配置后仍能完成文本请求；没有证明全局 AGENTS.md、项目指令、插件、MCP、hooks 等全部被隔离。

### T05：Codex 未显式选择 Windows 沙箱时，读写均被策略拒绝

来源：用户正式版与 reviewer alpha 环境均观察到类似结果。

参数组合：

```text
--ignore-user-config --skip-git-repo-check --sandbox read-only
```

- 请求创建随机命名测试文件：写命令启动前返回 `blocked by policy`，文件不存在。
- 请求读取工作目录内设计文档：读取命令也返回 `blocked by policy`。
- reviewer 尝试读取工作目录外测试文件，加入 `--ignore-rules` 后仍被拒绝。
- 结论：此组合下文本请求可用，但不能据此认为文件只读能力可用。之前“禁止写入通过”的早期判断需要结合读取失败一起看。

定位线索：本机用户配置含 `[windows] sandbox = "elevated"`，但 `--ignore-user-config` 会忽略用户配置。显式补回该设置后，用户正式版的读取成功。此结果支持该设置是本机调用所需条件，但不是对所有系统的通用根因证明。

### T06：Codex 显式 Windows 沙箱，工作目录内读取

来源：用户终端，Codex `0.169.0`；通过。

```powershell
'请实际使用工具读取 C:\Projects\jixia\jixia 设计文档 v1.md，只返回第一行。不要修改文件。' |
    codex exec --ignore-user-config -c 'windows.sandbox="elevated"' --skip-git-repo-check --sandbox read-only -
```

- 实际 `Get-Content` 命令成功。
- 首次未明确编码时出现中文乱码；重试加 `-Encoding UTF8` 后正确返回 `# jixia 设计文档 v1`。
- 实现提示：读取中文文本时明确使用 UTF-8，不依赖 shell 默认编码。

### T07：Codex 同组参数下禁止创建文件

来源：用户终端，Codex `0.169.0`；通过本次探测。

参数与 T06 一致。请求向项目内随机路径写入 `TEST`。

- 模型实际调用 `[System.IO.File]::WriteAllText(...)`。
- 命令进程启动后写入失败，返回 `UnauthorizedAccessException` / `Access ... is denied`。
- 用户用 `Test-Path` 检查，结果为 `False`。
- 与 T05 不同：不是所有命令启动前被笼统拒绝，而是本次文件写入被拒绝；结合 T06，确认同组配置下该读取成功、该写入失败。
- 无测试文件需要清理。
- 限制：只测试了创建单个文件；尚未逐项测试覆盖、删除、重命名、其他路径及其他写入工具，不宣称已穷尽所有写入途径。

### T08：Codex 从空工作目录读取目录外文件

来源：用户终端，Codex `0.169.0`；通过。

- 在 `C:\Projects\jixia` 下创建随机命名的临时空子目录，用 `--cd` 将其设为 CLI 工作目录。
- 参数继续使用 `--ignore-user-config -c 'windows.sandbox="elevated"' --skip-git-repo-check --sandbox read-only`。
- 请求以 UTF-8 读取其父目录中的 `jixia 设计文档 v1.md` 第一行。
- 工具日志显示工作目录为临时子目录，目录外读取成功，返回正确中文标题。
- 临时空目录已由用户脚本清理。
- 限制：仅验证工作目录外、同一项目树内的一个可读文件，不代表整个账号可读范围均已验证。

启动时另有 `failed to load models cache: EOF while parsing a value at line 1 column 0`。该错误未阻断本次请求；原因未定位，未删除或修改缓存。

### T09：Claude 仅开放 Read 时的读取与写入

来源：reviewer 执行环境，Claude Code `2.1.325`。

初始参数：

```text
-p --tools Read --strict-mcp-config --permission-mode dontAsk --no-session-persistence --output-format json
```

- 创建文件请求：模型报告只有 Read，没有写入或 shell 工具；文件不存在。
- 读取工作目录外测试文件：实际 Read 调用被权限拒绝，JSON 中有对应 `permission_denials`。

补充授权后的参数：

```text
-p --tools Read --allowedTools Read --add-dir <临时测试目录> --strict-mcp-config --permission-mode dontAsk --no-session-persistence --output-format json
```

- 在临时空子目录启动，读取上一级测试目录的样本文件成功。
- 返回“中文读取测试：”及随机 GUID，与实际文件完全一致；没有把 GUID 放入请求正文。
- 使用同组参数再次请求创建文件：模型报告无写入工具，文件不存在。
- 测试样本文件及临时目录已由 reviewer 清理。
- 结论：补充授权的配置可完成该指定目录外读取，且本次未能写入。
- 限制：工具清单主要由参数和模型响应佐证；未做全部工具或路径的穷尽验证。尚未验证这套参数是否完全隔离自动加载的指令和配置。

### T10：版本及执行环境限制

- reviewer 初次启动嵌套 Codex 时，受外层执行权限限制，初始化本地状态失败；该次不是模型测试结果。
- reviewer 改用正常本机执行权限后，嵌套模型仍保留 read-only 参数。
- reviewer alpha 版显式设置 `windows.sandbox="elevated"` 后，读取失败于 `registered Core launch requires an installed app`。
- 用户正式版相同核心参数成功。因此 Codex 文件操作的候选方案以用户正式版结果为依据，不能用 alpha 环境替代复测。
- 本机 Claude `--help` 明确写明 `--bare` 不读取 OAuth，只使用 API key / apiKeyHelper 等认证；当前订阅方案不采用它。未实际运行 `--bare` 的模型请求。

### T11：业务 schema 结构化输出

来源：reviewer 执行环境；Claude Code `2.1.325`，Codex `0.169.0-alpha.11.1`。两者各三个样例，本轮共六个请求，全部通过本地格式和预期语义校验。用户正式版 Codex `0.169.0` 尚未复测本项。

可复用测试脚本：`tests/cli-structured/run.mjs`；schema：`tests/cli-structured/schema.json`。Node 使用参数数组启动 CLI，prompt 通过 UTF-8 stdin 输入，每个样例一个独立进程，超时为 90 秒。保留 stdout、stderr、最终结构化响应及 summary.json，不写入 app 的实际记忆。

schema 顶层为 `reply: string` 与 `memoryRequests: array`；请求包含 `target: common|self`、`op: append`、`content: string`，所有字段必填，不允许额外字段。

| 样例 | 预期 | Claude | Codex alpha |
| --- | --- | --- | --- |
| 普通中文回答 | 指定回复，memoryRequests 为空 | 通过 | 通过 |
| 明确要求记入公共记忆 | 一条 common / append 请求，保留简短中文回答偏好 | 通过 | 通过 |
| 解释并原样引用 XML 示例，明确不记忆 | reply 保留标签，memoryRequests 为空 | 通过 | 通过 |

- Claude 使用 `--json-schema`，从 CLI JSON 外层的 `structured_output` 字段取得业务对象。不是从 `result` 文本任意解析。
- Codex 使用 `--output-schema`，用 `--output-last-message` 保存最终业务 JSON；`--json` 输出另存为事件日志。CLI 写最终输出文件与模型发起文件工具调用不同，read-only 不阻止 CLI 自身输出文件。
- 脚本校验字段、类型、枚举、额外字段及样例预期。此次没有让模型实际调用文件工具。
- Claude 原始结果：`tests/cli-structured/results/claude-2026-11-15T03-19-35.373Z/`。
- Codex 原始结果：`tests/cli-structured/results/codex-2026-11-15T03-19-57.547Z/`。
- 限制：每种情形只测一次，只支持协议可行性，不证明稳定性或授权判断可靠；未测试所有字段枚举、异常退出、拒绝响应、超时、超长输出或恶意输入。没有实际记忆写入成功与否的端到端验证。
- 当前建议：结构化协议可以作为候选，仍需作者决定是否替换设计文档中的尾部 XML 协议，并在正式版复测。

### T12：自动加载项目指令的隔离对照

来源：reviewer 执行环境；Claude `2.1.325`、Codex `0.169.0-alpha.11.1`。本轮四个短请求全部按预期返回。

脚本：`tests/cli-isolation/run.mjs`。在独立测试子目录分别创建 `CLAUDE.md` 和 `AGENTS.md`，文件包含随机标记；请求正文不含标记，只问“启动指令提供了测试标记则返回，否则返回 NONE”，并禁止工具读取。

| 条件 | 结果 |
| --- | --- |
| Claude 原候选配置 | 返回 CLAUDE.md 中的随机标记 |
| Claude 加 `--setting-sources ''` 与显式 settings：`claudeMdExcludes: ["**"]`、`autoMemoryEnabled: false`、`disableAllHooks: true` | 返回 NONE |
| Codex `--ignore-user-config` 原候选配置 | 仍返回 AGENTS.md 中的随机标记 |
| Codex 再加 `-c project_doc_max_bytes=0` | 返回 NONE |

- 四次没有观察到工具使用证据；Claude 返回 `num_turns=1`，Codex 没有命令或 MCP 工具事件。
- 关键结论：`--ignore-user-config` 本身不隔离项目 AGENTS.md；Claude 仅限制工具与 MCP 也不隔离 CLAUDE.md。
- Claude 新参数下请求仍正常完成，没有换用 `--bare`，没有复制或修改认证文件。此轮没有独立审计实际收费路径。
- 这是受控项目指令的行为对照，有正向基线，但不等于完整输入审计：未在真实全局指令中放标记，不能宣称所有用户、托管指令、插件、skills、hooks 和自动记忆都已隔离。此轮也未重新验证新配置的文件读取。
- Claude 的 `claudeMdExcludes` 不能排除 managed CLAUDE.md。`project_doc_max_bytes=0` 的测试结论限于本次项目指令，不泛化为所有全局上下文关闭。
- 官方依据：[Claude memory 文档](https://code.claude.com/docs/en/memory) 中的 `claudeMdExcludes`；[Codex 项目指令加载源码](https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs) 中零预算分支。源码可能与安装版本不同，最终以本轮本机对照为依据。
- 原始输出及 summary：`tests/cli-isolation/results/2026-11-15T03-22-43.877Z/`。
- 测试指令文件保留在上述结果目录的 `claude-work` 和 `codex-work` 子目录，作为可审查样本；没有修改全局或项目根目录的指令文件。后续 CLI 不应将这些样本目录用作正常聊天工作目录。

### T13：独立进程历史隔离与显式历史恢复

来源：reviewer 执行环境；Claude Code `2.1.325`，Codex `0.169.0-alpha.11.1`。

脚本：`tests/cli-history/run.mjs`。每个 provider 使用同一个空测试工作目录连续启动三个新进程，不带 resume/continue，不要求永久记忆。使用 T12 增量隔离参数及 `{reply: string}` schema；每家生成不同随机暗号。

| 调用 | 输入 | 两家最终结果 |
| --- | --- | --- |
| 第一次 | 提供随机暗号，要求返回 | 暗号完全匹配 |
| 第二次 | 不带暗号或历史，询问上次暗号；不知道则返回 UNKNOWN | 均返回 UNKNOWN |
| 第三次 | app 显式传入含暗号的用户／助手历史，再询问 | 暗号完全匹配 |

- 每次返回的 session/thread ID 不同，所有模型请求正常退出，业务 JSON 字段与类型均通过校验。
- Codex 事件日志没有文件／命令／MCP 等工具事件。Claude 补跑使用 `--output-format stream-json --verbose`，事件中没有 Read 或其他非 StructuredOutput 工具调用；结构化响应正常。
- 结论：在本轮设置和样例下，新进程没有表现出继承上次暗号的行为；显式拼入历史后能正确恢复。增量配置隔离参数与本轮业务 schema 输出兼容。
- 限制：第二次返回 UNKNOWN 是单样例行为证据，不能证明内存或服务端绝对不存在历史数据；没有穷尽其他登录、配置或恢复模式；没有验证不同群的 app 级数据隔离。该配置下文件读取兼容性仍待测。
- 首轮原始输出及 Codex 三个有效结果：`tests/cli-history/results/2026-11-15T03-26-00.436Z/`。
- 首轮 Claude 的回答和 JSON 均正确，但脚本用 `num_turns > 1` 推断文件工具使用，导致三个样例被保守标为失败。这是测试脚本的判断问题；不能用响应轮数证明发生过 Read 调用。保留首轮原始 summary，不事后改写。
- 修正脚本，改为检查 Claude 流式事件的实际工具名称后，补跑 Claude 三个样例全部通过，日志：`tests/cli-history/results/2026-11-15T03-26-43.691Z/`。
- 本轮共九个短请求（含三次 Claude 补跑）。脚本、schema、prompt、stdout、stderr、最终 JSON、summary 均保存在项目内。空工作目录作为测试产物保留，没有新增永久记忆。

### T14：要求冲突优先级、同层更新与临时要求范围

来源：reviewer 执行环境；Claude Code `2.1.325`、Codex `0.169.0-alpha.11.1`。两家各九个短请求，共 18 个，全部通过本次预期校验。

脚本：`tests/cli-priority/run.mjs`。采用 T12 的隔离参数、T11 的业务 schema，每次调用新进程。将简短的测试记忆及对话直接放进 prompt，依次标注公共记忆、私有记忆、对话摘要、最近对话、当前消息；通用规则明确说明优先级和作用范围。

| 样例 | 预期标记 | Claude | Codex alpha |
| --- | --- | --- | --- |
| 只有公共记忆 | BLUE | 通过 | 通过 |
| 私有记忆覆盖公共记忆 | GREEN | 通过 | 通过 |
| 本群对话要求覆盖私有记忆 | RED | 通过 | 通过 |
| 当前消息覆盖本群对话要求 | GOLD | 通过 | 通过 |
| 同一公共记忆中靠后的新条目替代旧条目 | SILVER | 通过 | 通过 |
| 同群对话中新的明确要求替代旧要求 | ORANGE | 通过 | 通过 |
| 本次临时要求立即生效 | GOLD | 通过 | 通过 |
| 历史中的临时要求已经用过，当前恢复私有记忆要求 | GREEN | 通过 | 通过 |
| 另一个 bot 提议改要求，用户明确不采用 | RED（维持既有用户要求） | 通过 | 通过 |

- 所有响应均含预期 reply，`memoryRequests` 均为空，结构校验通过，进程正常退出，未观察到非 StructuredOutput 工具调用。
- 没有写入实际长期记忆。这验证的是从已拼好的上下文中选择要求的行为，不是 app 的实际记忆文件更新机制。
- 临时要求生效与到期是分别构造输入的两个样例，不是让第一个实际模型回答自动流入第二个请求；完整输入可供审查。
- 限制：每个样例每家只测一次；测试使用明确的格式标记，尚未覆盖真实长对话、模糊范围、事实矛盾、未表态的 bot 建议或恶意指令；摘要段为空，不能宣称 compact 后优先级保真已经验证。规则通过拼装 prompt 约定执行，不是 API 原生角色层级的硬性保障。
- 原始 prompt、stdout、stderr、最终 JSON 和 summary：`tests/cli-priority/results/2026-11-15T03-28-48.199Z/`。

### T15：两轮 compact 后的要求与关键事实保真

来源：reviewer 执行环境；Claude Code `2.1.325`、Codex `0.169.0-alpha.11.1`。本轮八个请求全部通过。

脚本：`tests/cli-compact/run.mjs`。使用 26 条合成 JSONL 记录（13 轮）与五节摘要模板，不修改实际群聊或永久记忆。压缩调用显式传入 `--model sonnet --effort low`，Claude JSON 报告实际模型为 `claude-sonnet-5-5`；普通读取摘要的 Claude 请求报告 `claude-fable-5-2`。

流程及结果：

1. 未压缩对照：两个 bot 读取 seq 1–18，均正确提取全部八个检查字段。
2. 第一次压缩：Sonnet 只总结 seq 1–12，生成五节摘要（786 个 JS 字符）；由脚本设置 `coveredThroughSeq: 12`。两个 bot 只看到该摘要及 seq 13–18（最近三轮），均正确提取全部字段。
3. 第二次压缩：Sonnet 输入旧摘要加 seq 13–20，生成新摘要（1029 个 JS 字符）；脚本设置 `coveredThroughSeq: 20`。两个 bot 只看到该摘要及 seq 21–26（最近三轮），均正确提取全部字段。

| 检查项 | 第一次压缩后 | 第二次压缩后 |
| --- | --- | --- |
| 当前格式标记 | RED（替代 BLUE） | CYAN（替代 RED） |
| 服务端口 | 43127（替代 3000） | 43128（替代 43127） |
| 超时 | 37500 毫秒 | 37500 毫秒 |
| 路径 | `C:\Projects\jixia\data\群聊-α\records.jsonl` 原样保留 | 原样保留 |
| 代码 | `const retries = 2;` 原样保留 | 原样保留 |
| review 负责人 | ChatGPT | ChatGPT |
| review 进度 | pending | pending |
| 未决定的全局并发 | UNKNOWN；不把 bot 建议的 8 当决定 | UNKNOWN |

- 已执行的一次性 GOLD 要求没有重新生效；公共记忆 BLUE、私有记忆 GREEN 没有覆盖群内有效要求。
- 示例端口 5000 没有被当成真实配置；bot 提出的布局候选也保留为未确认状态。
- 两份摘要均低于要求的 1800 字符上限，并包含五节。来源 seq 在摘要中可查；尚未对所有来源引用做自动精确校验。
- 两次压缩及六次对照／读取请求均正常退出、满足对应业务 schema，未观察到非 StructuredOutput 工具调用。
- 原始 fixture、prompt、stdout、stderr、schema、最终 JSON、两份带边界的 Markdown 摘要及 summary：`tests/cli-compact/results/2026-11-15T03-32-20.748Z/`。
- 限制：这是短合成上下文上的两轮语义测试，没有达到真实 4 万 token 触发阈值，不证明长上下文保真或长期多轮稳定性；未测后台并发、失败恢复、原子替换和实际 app 边界调度。coveredThroughSeq 由脚本按已知范围写入，不是模型推断，也不是已实现的调度器功能。尚无额度或压缩收益的受控测量。

### T16：双 CLI 并行、单边失败及超时回收

来源：reviewer 执行环境；Claude Code `2.1.325`、Codex `0.169.0-alpha.11.1`。三个场景均通过，使用前述增量隔离参数、只读限制和 stdin。脚本：`tests/cli-parallel/run.mjs`。

| 场景 | Claude | Codex | 结果 |
| --- | --- | --- | --- |
| 正常并行 | 3285ms，返回指定标记 | 3877ms，返回指定标记 | 两个进程运行区间重叠约 3280ms |
| Claude 无效参数 | 124ms 后以退出码 1 报 unknown option | 2698ms，正常回答，退出码 0 | 单边启动参数错误没有终止另一调用 |
| Claude 人为超时 | 1800ms 定时器触发回收；进程约 2421ms 后关闭 | 4794ms，正常回答，退出码 0 | 超时回收没有终止另一调用 |

- 正常并行场景同时 spawn 两个进程后才等待完成，启动相差约 5ms。观测的是 CLI 进程运行区间重叠，不等于精确测量供应商服务端推理区间。
- 超时前快照记录本次 Claude PID 27016 及其 conhost 子进程 PID 13256；仅对本次 spawn 得到、尚未退出的 Claude PID 执行 `taskkill /PID ... /T /F`，未按进程名称批量终止。
- taskkill 退出码为 0，报告两个进程均已终止。随后根据 PID 与创建时间核对快照中的进程，未发现残留，避免把复用 PID 误判为原进程。
- 1800ms 是测试的主动超时阈值，不是建议的生产超时。实际关闭含进程树检查和终止开销，不能承诺到阈值即完成回收。
- 超时的 Claude 日志已出现 `system/init`，但尚未返回助手回答；不能据此确认供应商服务端请求是否已开始，或终止后服务端计算／额度消耗是否同步停止。此次只验证本地回收。
- 本轮仅在 Claude 出错／超时、Codex 正常这一方向做注入；未做反向注入，也未验证所有工具子进程或终止时新生子进程的竞态。
- 所有阶段输出、退出码、毫秒时间戳、进程树快照、taskkill 结果和 summary 已保存：`tests/cli-parallel/results/2026-11-15T03-36-15.482Z/`。
- 测试启动六个 CLI 进程，其中一个因参数无效未进入模型调用；没有修改 app 数据或实际记忆。
- 此结果仅验证 CLI 调用层，不代表 app 的 FIFO／手动重排、整轮完成判断、故障落盘、重启恢复或全局限流已经实现或验证。

### T17：完整参数读取与清理子进程 API/provider 环境

来源：reviewer 执行环境；Claude `2.1.325`、Codex `0.169.0-alpha.11.1`。脚本：`tests/cli-final-checks/run.mjs`。四个请求中三个通过，Codex 文件读取仍因环境限制失败。

- 复制当前进程环境，仅在测试子进程中移除已列举的 API key、API endpoint 和 AWS/Google/Azure provider 覆盖变量；不修改全局环境、订阅 OAuth 或认证目录。此次列表内变量本来就不存在，`removedEnvironmentVariableNames` 为 `[]`，没有假装实际移除了密钥。
- 清理环境后 Claude 登录状态显示 `loggedIn=true`、`authMethod=claude.ai`、`apiProvider=firstParty`、`subscriptionType=pro`；模型初始化事件显示 `apiKeySource=none`。短模型请求成功。
- Codex 清理后状态仍为 ChatGPT 登录，短模型请求成功。
- Claude 在 T12 隔离设置、目录授权和业务 schema 合并使用时，实际调用 Read，成功从空工作目录之外读取新生成的随机中文标记，原文完全匹配。
- Codex 同组配置下读取失败，仍返回 `registered Core launch requires an installed app`；不重复消耗请求尝试同一已知环境问题。用户正式版以前在较少隔离参数下读取成功（T08），完整新增参数组合在正式版尚未验证。
- 结论：本次未发现依赖上述 API/provider 环境变量的情况，订阅登录请求正常；不等于审计实际账单，也没有完整排除托管设置、所有可能的配置层或环境变量。
- 脚本不记录认证状态原始输出，只保存所需的非个人认证标签，不读取认证文件。
- 结果、随机测试文件和响应：`tests/cli-final-checks/results/2026-11-15T03-40-41.131Z/`。测试文件作为原始证据保留，未修改 app 数据。

### T18：最小调度器核心的本地模拟测试

用户同意补充检查后开始最小调度器，已增加 `src/scheduler.ts`、`package.json`、`README.md`。未提供网页或真实 CLI adapter。

执行命令：`node --test tests/scheduler.test.ts`。五项测试通过（0 失败）：

1. 编辑取回、删除、移到队首、相同提交去重，重开数据后保持队列顺序。
2. 同轮 bot 同时开始、收到独立历史快照；下一轮等待两者结束，并看到前轮两个回答；已出队消息拒绝编辑和重排。
3. 一个模拟 bot 失败，另一个和下一轮正常完成，失败写入历史。
4. 二十个并发 enqueue-and-drain 调用不丢失、不重复消息。
5. 真实启动独立 Node 子进程，保存一个 bot 回答后终止；模拟日志尾部半写入，重启保留已有回答、为未完成 bot 记录中断、不重试，并恢复和继续处理待排队消息。

实现选择：每群 `events.jsonl` 是唯一事实来源，开始事件同时表达出队和用户消息写入。该选择避免两个独立文件之间的提交窗口，与设计文档中的 `queue.json` 加聊天 JSONL 不完全相同；README 明确说明，尚未改写设计文档。每条已提交事件写入后 sync，重启重放恢复。聊天 seq 与队列 ID 分离。

限制：仅有单进程、每群单 writer 核心，没有跨进程锁、永久记忆、compact、路由解析、HTTP/WebSocket、前端或生产 CLI adapter。测试中的 bot 超时是 adapter 已完成清理后抛出的模拟失败，不是核心自身负责终止进程。真实 CLI 回收单独见 T16。

reviewer 环境找不到 npm 命令，使用其内置 Node 24 直接执行测试；用户独立 Node 环境可用 `npm test` 执行相同命令。没有安装依赖。

## 当前候选调用参数

### Codex（用户正式版已做文件读写探测）

```powershell
codex exec --ignore-user-config -c 'windows.sandbox="elevated"' --skip-git-repo-check --sandbox read-only -
```

`-` 从 stdin 接收 prompt；专用空目录通过 `--cd` 指定。`elevated` 是 Windows 沙箱实现选择，不是授予模型管理员权限。`--ignore-user-config` 后需要显式保留本机所需设置，不能默认全部配置都可丢弃。

T12 进一步验证，在上述参数上追加 `-c project_doc_max_bytes=0` 可使本次测试的项目 AGENTS.md 不再影响回答；用户正式版尚未复测此新增设置。

### Claude（reviewer 环境已做文件读写探测）

```text
claude -p --tools Read --allowedTools Read --add-dir <允许读取的目录> --strict-mcp-config --permission-mode dontAsk --no-session-persistence --output-format json
```

工具开放、工具授权、目录范围是不同问题；仅使用 `--tools Read` 不保证目录外读取无需授权。候选命令仍需后续配置隔离验证。

T12 的增量隔离参数（通过 Node 参数数组传递空字符串，避免 shell 丢失空参数）：

```text
--setting-sources "" --settings '{"claudeMdExcludes":["**"],"autoMemoryEnabled":false,"disableAllHooks":true}'
```

本轮验证该组合排除了测试项目 CLAUDE.md 的行为影响，未逐项验证其中每一个设置；完整隔离与新组合下的读取权限仍待测。

## 尚未验证

- 结构化输出的重复稳定性及异常响应处理；业务 schema 基础可行性已在 T11 验证。用户接受继续基于 alpha 版结果推进，不要求逐项正式版复测，但记录仍保留版本范围。
- 用户／托管指令、MCP、插件、skills、hooks 和自动记忆的完整隔离。项目 CLAUDE.md / AGENTS.md 基础对照已在 T12 验证。
- 新进程历史隔离与显式历史恢复的基础样例已在 T13 验证；更广泛的跨群、配置与恢复模式仍未验证。
- 要求冲突优先级、同层以新替旧、临时要求作用范围的基础样例已在 T14 验证；真实长上下文与模糊要求仍未验证。
- compact 的基础信息保真和两轮边界拼装样例已在 T15 验证；真实长上下文、长期迭代、后台并发和失败恢复未验证。
- 双 CLI 并行、单方向启动失败隔离与本地超时回收已在 T16 验证；反向注入、服务端取消、真实调度器状态、全局并发限制未验证。
- 不同模型及 effort 在订阅下的可用性。
- T17 已做已列举 API/provider 环境的子进程清理检查并成功调用；本次原环境没有这些变量，未做全配置层或实际账单审计。
- 订阅实际额度消耗、不同模型额度差异、system prompt 开销。
- cache：Claude JSON 曾返回非零 cache read / creation token 数，但没有受控对照实验，不能推断 app 的固定前缀缓存收益。JSON 中的美元成本字段也不能直接视为实际扣款证据。
- T18 已验证最小核心的队列、事件落盘与崩溃恢复；实际记忆写入、WebSocket 重连和完整 app 尚未实现。

## 下一步

T17 补充检查完成（Codex alpha 完整参数读取仍有限制），T18 最小调度器核心和五项模拟测试已完成。后续可接真实 CLI adapter、结构化记忆请求和 HTTP/WebSocket 服务，再做队列与界面的端到端验收。保持每轮测试范围小，不把单次成功泛化为稳定性保证。
