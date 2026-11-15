// Live check that Claude Code reads the stable part of the prompt from its
// cache on the next round. Builds three rounds of one group with the app's own
// prompt assembly and sends them the way runCli does, reading the token usage.
// Makes three short calls on a small model. Not part of `npm test`.
//   node tests/cache-live.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, runProcess, splitPrompt, subscriptionEnv } from '../src/cli.ts';
import { assembleParts } from '../src/context.ts';

for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const work = await mkdtemp(join(tmpdir(), 'jixia-cache-'));
const run = Date.now().toString(36); // So an earlier run's cache cannot be what is hit.
const msg = (seq, from, content) => ({ seq, id: `m${seq}`, ts: new Date().toISOString(), from, type: from === 'user' ? 'user' : 'reply', content });
const base = {
  system: await readFile(join(project, 'prompts', 'system.md'), 'utf8'), bot: 'claude', bots: ['claude', 'chatgpt'], recordsPath: join(work, 'records.jsonl'),
  common: `[2026-11-15] 用户喝咖啡不加糖。（批次 ${run}）\n` + Array.from({ length: 60 }, (_, i) => `[2026-11-15] 第 ${i + 1} 条长期偏好：讨论方案时先给结论，再列理由和代价。`).join('\n'),
  self: '[2026-11-15] 回答尽量简短。',
  summary: { coveredThroughSeq: 40, body: Array.from({ length: 5 }, (_, i) => `## ${i + 1}. 第 ${i + 1} 节\n` + Array.from({ length: 12 }, (_, j) => `- 第 ${j + 1} 条要点：关于存储、调度和界面的一项已确认决定（seq ${j + 1}）。`).join('\n')).join('\n\n') },
  writer: 'claude',
};
let history = Array.from({ length: 40 }, (_, i) => msg(i + 1, i % 2 ? 'claude' : 'user', `第 ${i + 1} 条`));
const config = { provider: 'claude', workDir: work, readDir: work, timeoutMs: 180000, model: 'haiku', effort: 'low' };
const results = [];
let failed = false;
try {
  for (const [index, question] of ['只回复：甲', '只回复：乙', '只回复：丙'].entries()) {
    const message = msg(history.length + 1, 'user', question);
    const { stable, changing } = assembleParts({ ...base, history, message });
    const { system, stdin } = splitPrompt('claude', `${stable}\n${changing}`, stable);
    const files = { schema: join(work, 's.json'), final: join(work, 'f.json'), system: join(work, 'system.md') };
    await writeFile(files.system, system, 'utf8');
    const result = await runProcess('claude', buildArgs(config, files), { cwd: work, input: stdin + '\n', timeoutMs: config.timeoutMs, env: subscriptionEnv() });
    const envelope = JSON.parse(result.stdout);
    const u = envelope.usage;
    results.push(u);
    console.log(`round ${index + 1}: fresh ${u.input_tokens}, cache write ${u.cache_creation_input_tokens}, cache read ${u.cache_read_input_tokens} | ${JSON.stringify(envelope.structured_output?.reply)}`);
    history = [...history, message, msg(message.seq + 1, 'claude', envelope.structured_output?.reply ?? '')];
  }
  const checks = {
    'rounds 2 and 3 read far more from the cache than round 1': results[1].cache_read_input_tokens > results[0].cache_read_input_tokens + 5000 && results[2].cache_read_input_tokens > results[0].cache_read_input_tokens + 5000,
    'rounds 2 and 3 write far less to the cache than round 1': results[1].cache_creation_input_tokens < results[0].cache_creation_input_tokens / 3 && results[2].cache_creation_input_tokens < results[0].cache_creation_input_tokens / 3,
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
