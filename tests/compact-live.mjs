// Live check of compaction: the real prompts/compact.md, the real CLI with the
// configured compact model, then both bots answering from the summary.
// Makes three model calls and uses subscription quota. Not part of `npm test`.
//   node tests/compact-live.mjs
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.ts';
import { createCompactor } from '../src/compact.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createPreparer, parseSummary } from '../src/context.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(project, '.live-data-'));
const work = join(root, 'work');
await mkdir(work);
const recordPath = 'C:\\Projects\\jixia\\data\\群聊-α\\records.jsonl';
// Same conversation as the earlier probe in tests/cli-compact: requirements
// that get replaced, a one-off requirement, an unadopted suggestion, exact values.
const lines = [
  ['user', '本群格式标记以后用 BLUE，服务端口先用 3000。'], ['claude', '确认。'],
  ['user', `端口改为 43127，CLI 超时为 37500 毫秒。记录文件路径是 ${recordPath}；代码片段必须原样保留：const retries = 2;`], ['chatgpt', '已确认这些约束。'],
  ['user', '长期的本群格式标记改为 RED，替代 BLUE。这里只调整本群，不写入永久记忆。'], ['claude', '确认，后续本群用 RED。'],
  ['user', '仅下一条回答用 GOLD，之后恢复本群格式标记。'], ['chatgpt', 'GOLD'],
  ['user', 'Claude 负责实现，ChatGPT 负责 review。review 尚未开始。'], ['claude', '接受实现任务；ChatGPT 的 review 仍待开始。'],
  ['user', '文档里出现 5000 只是端口示例，不改实际配置。全局并发上限还没决定。'], ['chatgpt', '我建议并发上限为 8，但这是尚未被用户采纳的建议。'],
  ['user', '先讨论界面布局，暂不改变已经确定的要求。'], ['claude', '可以将群列表放在左边。'],
  ['user', '这个布局方案先作为候选，尚未确认。'], ['chatgpt', '收到，保持候选状态。'],
  ['user', '还有其他布局思路吗？'], ['claude', '也可以使用顶部标签，目前没有新增决定。'],
  ['user', '更新：本群格式标记以后改为 CYAN，端口改为 43128，其他要求不变。'], ['chatgpt', '确认这两项更新，review 仍未开始。'],
  ['user', '继续讨论界面，配置保持不变。'], ['claude', '可以增加折叠群列表的按钮。'],
  ['user', '先保留这些候选方案。'], ['chatgpt', '收到，没有新增配置决定。'],
  ['user', '界面之后再定。'], ['claude', '好的，已有要求和任务状态保持不变。'],
];
let userSeq = 0;
const history = lines.map(([from, content], index) => {
  const seq = index + 1;
  if (from === 'user') userSeq = seq;
  return { seq, id: `r${seq}`, ts: new Date().toISOString(), from, type: from === 'user' ? 'user' : 'reply', ...(from === 'user' ? {} : { replyTo: userSeq }), content };
});
const { compact } = DEFAULT_CONFIG;
const summaryPath = join(root, 'summary.md');
const cli = (provider, extra = {}) => (prompt, stable) => runCli({ provider, workDir: work, readDir: root, timeoutMs: 180000, ...extra }, prompt, stable);
let failed = false;
try {
  // Thirteen rounds; keeping three means rounds 1-10 (seq 1-20) are compressed.
  const run = createCompactor({
    summaryPath, templatePath: join(project, 'prompts', 'compact.md'),
    settings: { thresholdTokens: 100, keepRounds: compact.keepRounds, maxSummaryTokens: compact.maxSummaryTokens, maxPromptTokens: DEFAULT_CONFIG.maxPromptTokens },
    run: async prompt => (await cli(compact.provider, { model: compact.model, effort: compact.effort })(prompt)).reply,
  });
  const started = Date.now();
  const times = await run(() => ({ history, activeUserSeq: null }));
  const summary = parseSummary(await readFile(summaryPath, 'utf8'));
  console.log(`--- summary (${Math.round((Date.now() - started) / 1000)}s, ${summary.body.length} chars) ---\n${summary.body}\n---`);
  const first = summary.body.slice(0, summary.body.indexOf('## 2'));

  const question = { seq: 27, id: 'q', ts: new Date().toISOString(), from: 'user', type: 'user', content: '现在本群的格式标记是什么？端口和 CLI 超时各是多少？代码片段是什么？全局并发上限定了吗？review 谁负责、开始了吗？逐项简短回答。' };
  const prepare = createPreparer({
    systemPath: join(project, 'prompts', 'system.md'), commonPath: join(root, 'common.md'), selfPath: bot => join(root, `${bot}.md`),
    summaryPath, recordsPath: join(root, 'records.jsonl'), bots: ['claude', 'chatgpt'], defaultWriter: 'claude',
  });
  const prompts = await prepare({ message: { id: 'q', content: question.content, targets: ['claude', 'chatgpt'] }, history: [...history, question] });
  const [claude, chatgpt] = await Promise.all([cli('claude')(prompts.claude.prompt, prompts.claude.stable), cli('codex')(prompts.chatgpt.prompt, prompts.chatgpt.stable)]);
  for (const [name, output] of [['claude', claude], ['chatgpt', chatgpt]]) console.log(`--- ${name} ---\n${output.reply}`);
  const knows = reply => reply.includes('CYAN') && reply.includes('43128') && reply.includes('37500') && reply.includes('const retries = 2;') && !/并发上限(是|为)\s*8/.test(reply);
  const checks = {
    'one compaction, covering through seq 20': times === 1 && summary.coveredThroughSeq === 20,
    'section 1 has the current values, with their source seq': first.includes('CYAN') && first.includes('43128') && /seq\s*19/.test(first),
    'section 1 dropped the replaced and one-off values': !first.includes('BLUE') && !first.includes('GOLD') && !first.includes('43127'),
    'exact values survive': summary.body.includes('37500') && summary.body.includes('const retries = 2;') && summary.body.includes(recordPath),
    'the unadopted suggestion is not a decision': !/\b8\b/.test(first),
    'the prompt carries the summary and only later raw messages': prompts.claude.prompt.includes(summary.body) && !prompts.claude.prompt.includes('"seq":20,') && prompts.claude.prompt.includes('"seq":21,'),
    'claude answers correctly from the summary': knows(claude.reply),
    'chatgpt answers correctly from the summary': knows(chatgpt.reply),
    'no memory writes were requested': claude.memoryRequests.length === 0 && chatgpt.memoryRequests.length === 0,
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
