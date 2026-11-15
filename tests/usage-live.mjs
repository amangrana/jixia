// Measures what each CLI adds on top of our prompt and whether separate
// processes share a prompt cache. Reads the token usage each CLI reports.
// Makes eight short calls on small models. Not part of `npm test`.
//   node tests/usage-live.mjs
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgs, OUTPUT_SCHEMA, runProcess, subscriptionEnv } from '../src/cli.ts';
import { estimateTokens } from '../src/tokens.ts';

for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const work = await mkdtemp(join(tmpdir(), 'jixia-usage-'));
const files = { schema: join(work, 'schema.json'), final: join(work, 'final.json') };
await writeFile(files.schema, JSON.stringify(OUTPUT_SCHEMA));
const system = await readFile(join(project, 'prompts', 'system.md'), 'utf8');
// A stand-in for a real round: instructions plus a stretch of history, the same in both calls, then a different question.
const prefix = `# 通用指令\n${system}\n\n# 摘要之后的原文\n${Array.from({ length: 60 }, (_, i) => JSON.stringify({ seq: i + 1, from: i % 2 ? 'claude' : 'user', content: `第 ${i + 1} 条：关于本地群聊应用的存储、调度和界面的一段讨论，内容用来占位，长度和真实对话接近。` })).join('\n')}\n\n# 当前用户消息\n`;
const prompts = { 'tiny-1': '只回复：好', 'tiny-2': '只回复：好', 'long-1': prefix + '只回复：甲', 'long-2': prefix + '只回复：乙' };

async function call(provider, prompt) {
  const config = { provider, workDir: work, readDir: work, timeoutMs: 180000, model: provider === 'claude' ? 'haiku' : 'gpt-6-luna', effort: 'low' };
  const result = await runProcess(provider, buildArgs(config, files), { cwd: work, input: prompt + '\n', timeoutMs: config.timeoutMs, env: subscriptionEnv() });
  if (result.exitCode !== 0) throw new Error(`${provider} exit ${result.exitCode}: ${result.stderr.slice(-300)}`);
  if (provider === 'claude') {
    const usage = JSON.parse(result.stdout).usage;
    return { fresh: usage.input_tokens, cacheWrite: usage.cache_creation_input_tokens, cacheRead: usage.cache_read_input_tokens, output: usage.output_tokens };
  }
  const done = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).findLast(event => event.type === 'turn.completed');
  // Codex reports cached tokens as part of input_tokens.
  return { fresh: done.usage.input_tokens - done.usage.cached_input_tokens, cacheWrite: done.usage.cache_write_input_tokens ?? 0, cacheRead: done.usage.cached_input_tokens, output: done.usage.output_tokens };
}

try {
  console.log(`our estimate: tiny prompt ${estimateTokens(prompts['tiny-1'])} tokens, long prompt ${estimateTokens(prompts['long-1'])} tokens`);
  for (const provider of ['claude', 'codex']) {
    for (const [name, prompt] of Object.entries(prompts)) {
      const usage = await call(provider, prompt);
      console.log(`${provider.padEnd(6)} ${name}: total input ${usage.fresh + usage.cacheWrite + usage.cacheRead} = fresh ${usage.fresh} + cache write ${usage.cacheWrite} + cache read ${usage.cacheRead}; output ${usage.output}`);
    }
  }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
