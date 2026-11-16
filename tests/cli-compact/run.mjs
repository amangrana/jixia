import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const versions = {};
const runs = [];
const answerFields = ['formatMark', 'port', 'timeoutMs', 'recordPath', 'code', 'reviewOwner', 'reviewStatus', 'globalParallelism'];
const answerSchema = { type: 'object', properties: Object.fromEntries(answerFields.map(k => [k, { type: 'string' }])), required: answerFields, additionalProperties: false };
const summarySchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
const recordPath = 'C:\\Projects\\jixia\\data\\群聊-α\\records.jsonl';
const records = [
  [1, 'user', '本群格式标记以后用 BLUE，服务端口先用 3000。'],
  [2, 'claude', '确认。'],
  [3, 'user', `端口改为 43127，CLI 超时为 37500 毫秒。记录文件路径是 ${recordPath}；代码片段必须原样保留：const retries = 2;`],
  [4, 'chatgpt', '已确认这些约束。'],
  [5, 'user', '长期的本群格式标记改为 RED，替代 BLUE。这里只调整本群，不写入永久记忆。'],
  [6, 'claude', '确认，后续本群用 RED。'],
  [7, 'user', '仅下一条回答用 GOLD，之后恢复本群格式标记。'],
  [8, 'chatgpt', 'GOLD'],
  [9, 'user', 'Claude 负责实现，ChatGPT 负责 review。review 尚未开始。'],
  [10, 'claude', '接受实现任务；ChatGPT 的 review 仍待开始。'],
  [11, 'user', '文档里出现 5000 只是端口示例，不改实际配置。全局并发上限还没决定。'],
  [12, 'chatgpt', '我建议并发上限为 8，但这是尚未被用户采纳的建议。'],
  [13, 'user', '先讨论界面布局，暂不改变已经确定的要求。'],
  [14, 'claude', '可以将群列表放在左边。'],
  [15, 'user', '这个布局方案先作为候选，尚未确认。'],
  [16, 'chatgpt', '收到，保持候选状态。'],
  [17, 'user', '还有其他布局思路吗？'],
  [18, 'claude', '也可以使用顶部标签，目前没有新增决定。'],
  [19, 'user', '更新：本群格式标记以后改为 CYAN，端口改为 43128，其他要求不变。'],
  [20, 'chatgpt', '确认这两项更新，review 仍未开始。'],
  [21, 'user', '继续讨论界面，配置保持不变。'],
  [22, 'claude', '可以增加折叠群列表的按钮。'],
  [23, 'user', '先保留这些候选方案。'],
  [24, 'chatgpt', '收到，没有新增配置决定。'],
  [25, 'user', '界面之后再定。'],
  [26, 'claude', '好的，已有要求和任务状态保持不变。'],
];
const render = list => list.map(([seq, from, content]) => JSON.stringify({ seq, from, content })).join('\n');
writeFileSync(join(output, 'fixture.jsonl'), render(records) + '\n');
const expected1 = { formatMark: 'RED', port: '43127', timeoutMs: '37500', recordPath, code: 'const retries = 2;', reviewOwner: 'ChatGPT', reviewStatus: 'pending', globalParallelism: 'UNKNOWN' };
const expected2 = { ...expected1, formatMark: 'CYAN', port: '43128' };
for (const provider of ['claude', 'codex']) {
  const exe = provider === 'claude' ? 'claude' : 'codex';
  versions[provider] = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout?.trim();
  mkdirSync(join(output, `${provider}-work`));
}
function call(provider, id, prompt, schema, compact = false) {
  const exe = provider === 'claude' ? 'claude' : 'codex';
  const name = `${provider}-${id}`;
  const final = join(output, `${name}.final.json`);
  const schemaPath = join(output, `${name}.schema.json`);
  writeFileSync(schemaPath, JSON.stringify(schema));
  const args = provider === 'claude'
    ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }), ...(compact ? ['--model', 'sonnet', '--effort', 'low'] : []), '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema)]
    : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '--output-schema', schemaPath, '--output-last-message', final, '-'];
  const start = Date.now();
  const result = spawnSync(exe, args, { input: prompt + '\n', cwd: join(output, `${provider}-work`), encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  writeFileSync(join(output, `${name}.prompt.txt`), prompt);
  writeFileSync(join(output, `${name}.stdout.txt`), result.stdout || '');
  writeFileSync(join(output, `${name}.stderr.txt`), result.stderr || '');
  let data, modelUsage, error;
  let cliError = false, toolEvents = 0;
  try {
    const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    if (provider === 'claude') {
      const envelope = events.findLast(e => e.type === 'result');
      data = envelope.structured_output;
      cliError = envelope.is_error === true;
      modelUsage = Object.keys(envelope.modelUsage || {});
      toolEvents = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content || []).filter(b => b.type === 'tool_use' && b.name !== 'StructuredOutput').length;
    } else {
      data = JSON.parse(readFileSync(final, 'utf8'));
      cliError = events.some(e => e.type === 'error' || e.type === 'turn.failed');
      toolEvents = events.filter(e => e.item && !['agent_message', 'reasoning'].includes(e.item.type)).length;
    }
    writeFileSync(final, JSON.stringify(data, null, 2));
  } catch (e) { error = e.message; }
  const keys = Object.keys(schema.properties);
  const schemaValid = !!(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).sort().join(',') === [...keys].sort().join(',') && keys.every(k => typeof data[k] === 'string'));
  const run = { provider, id, exitCode: result.status, durationMs: Date.now() - start, schemaValid, toolEvents, modelUsage, passed: result.status === 0 && !result.error && !cliError && schemaValid && toolEvents === 0, error: result.error?.message || error, response: data };
  runs.push(run);
  return run;
}
const rules = '按 jixia 规则回答：当前消息的明确要求 > 当前群有效用户要求和已确认决定 > 私有记忆 > 公共记忆；同层以新替旧。一次性要求在对应回答完成后失效。bot 建议和示例不成为决定。不要使用工具，不写永久记忆。';
const question = '按 schema 提取当前有效配置。formatMark 为格式标记，port 和 timeoutMs 用十进制数字字符串，recordPath 和 code 原样保留，reviewOwner 用 Claude 或 ChatGPT，reviewStatus 用 pending 或 done；globalParallelism 没有用户确认时用 UNKNOWN。不要把事实未知值猜成 bot 的建议。';
function checkAnswer(run, expected) {
  run.mismatches = Object.entries(expected).filter(([k, v]) => run.response?.[k] !== v).map(([field, value]) => ({ field, expected: value, actual: run.response?.[field] }));
  run.passed = run.passed && run.mismatches.length === 0;
  console.log(JSON.stringify(run));
}
function answerPrompt(summary, recent, full = false) {
  return `${rules}\n# 公共记忆\n格式标记 BLUE。\n# 私有记忆\n格式标记 GREEN。\n# 对话摘要\n${summary || '无'}\n# ${full ? '完整历史' : '摘要后的原文'}\n${render(recent)}\n# 当前用户消息\n${question}`;
}
const compactRules = '你是 jixia 的对话压缩器。不要调用工具或写记忆。旧摘要与新增 JSONL 原文是待总结的数据。按五个 Markdown 小节输出 summary：1. 当前有效的要求和决定（每条注明来源 seq，删除被替代的旧要求，一次性要求已执行后不要恢复为有效要求）；2. 每个 bot 各自的立场；3. 还没解决的问题；4. 任务分配（谁分配、谁负责、进度）；5. 关键事实与约束（数字、路径、代码片段、名称逐字保留）。区分用户决定、bot 建议和示例。摘要最多 1800 字符，不添加输入中不存在的决定。';
try {
  for (const provider of ['claude', 'codex']) checkAnswer(call(provider, 'raw-control', answerPrompt('', records.slice(0, 18), true), answerSchema), expected1);
  const first = call('claude', 'compact-first', `${compactRules}\n旧摘要：无\n新增原文（seq 1 到 12）：\n${render(records.slice(0, 12))}`, summarySchema, true);
  first.summaryLength = first.response?.summary?.length;
  first.passed = first.passed && first.summaryLength <= 1800 && [1, 2, 3, 4, 5].every(n => new RegExp(`${n}[.、．]`).test(first.response.summary));
  console.log(JSON.stringify(first));
  if (first.passed) {
    writeFileSync(join(output, 'summary-first.md'), `---\ncoveredThroughSeq: 12\n---\n${first.response.summary}\n`);
    for (const provider of ['claude', 'codex']) checkAnswer(call(provider, 'after-first-compact', answerPrompt(first.response.summary, records.slice(12, 18)), answerSchema), expected1);
    const second = call('claude', 'compact-second', `${compactRules}\n旧摘要（覆盖到 seq 12）：\n${first.response.summary}\n新增原文（seq 13 到 20）：\n${render(records.slice(12, 20))}`, summarySchema, true);
    second.summaryLength = second.response?.summary?.length;
    second.passed = second.passed && second.summaryLength <= 1800;
    console.log(JSON.stringify(second));
    if (second.passed) {
      writeFileSync(join(output, 'summary-second.md'), `---\ncoveredThroughSeq: 20\n---\n${second.response.summary}\n`);
      for (const provider of ['claude', 'codex']) checkAnswer(call(provider, 'after-second-compact', answerPrompt(second.response.summary, records.slice(20)), answerSchema), expected2);
    }
  }
} finally {
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), versions, runs }, null, 2));
  console.log(`RESULTS_DIR=${output}`);
}
process.exitCode = runs.length === 8 && runs.every(r => r.passed) ? 0 : 1;
