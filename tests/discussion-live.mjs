// Live check of an automatic discussion with both real CLIs: one step after the
// first answers, then the summary. Five short calls on small models; uses
// subscription quota. Not part of `npm test`.
//   node tests/discussion-live.mjs
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.ts';
import { createPreparer } from '../src/context.ts';
import { Scheduler } from '../src/scheduler.ts';

for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = await mkdtemp(join(root, '.live-data-'));
const workDir = join(data, 'work');
await mkdir(workDir);
const models = { claude: { provider: 'claude', model: 'haiku', effort: 'low' }, chatgpt: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } };
const bots = Object.fromEntries(Object.entries(models).map(([name, bot]) => [name, input => runCli({ ...bot, workDir, readDir: root, timeoutMs: 180000 }, input.prompt, input.stable)]));
const prepare = createPreparer({
  systemPath: join(root, 'prompts', 'system.md'), commonPath: join(data, 'common.md'), selfPath: bot => join(data, `${bot}.md`),
  summaryPath: join(data, 'summary.md'), recordsPath: join(data, 'group', 'records.jsonl'), bots: Object.keys(models), defaultWriter: 'claude',
  discussionPath: join(root, 'prompts', 'discussion.md'),
});
let failed = false;
try {
  const scheduler = await Scheduler.open(join(data, 'group'), bots, { prepare, discussion: { defaultWriter: 'claude' } });
  await scheduler.enqueue({ id: 'm1', content: '一个只给自己用的 Windows 本地聊天应用，聊天记录应该存成 JSONL 文件还是 SQLite？请各自给出明确的选择和一两条理由，不要两边都说好。', discuss: 1 });
  await scheduler.runUntilIdle();
  const history = scheduler.history;
  for (const message of history) console.log(`--- ${message.from} ${message.discussion ?? ''} ${message.type}\n${message.content}`);
  const at = (from, step) => history.find(m => m.from === from && m.discussion === step);
  const checks = {
    'both bots answered first, then both took a discussion step': ['claude', 'chatgpt'].every(bot => at(bot, 1)?.type === 'reply' && at(bot, 2)?.type === 'reply'),
    'each discussion answer responds to the other bot by name': /chatgpt/i.test(at('claude', 2)?.content ?? '') && /claude/i.test(at('chatgpt', 2)?.content ?? ''),
    'the default writer wrote the summary': at('claude', 'summary')?.type === 'reply',
    'the summary covers agreement and disagreement': /共识|一致/.test(at('claude', 'summary')?.content ?? '') && /分歧|不同/.test(at('claude', 'summary')?.content ?? ''),
    'the round is over and nothing else ran': scheduler.round === null && history.filter(m => m.type === 'reply').length === 5,
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
