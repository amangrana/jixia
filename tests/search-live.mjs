// Live check of the webSearch switch: each CLI, with search on and off, is
// asked something only a live lookup can answer, and its raw output is read
// to see whether a search actually ran. Four short calls on small models; the
// two with search on cost more than usual. Not part of `npm test`.
//   node tests/search-live.mjs [claude] [codex]
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, OUTPUT_SCHEMA, parseOutput, runProcess, subscriptionEnv } from '../src/cli.ts';

for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];
const work = await mkdtemp(join(tmpdir(), 'jixia-search-'));
const files = { schema: join(work, 'schema.json'), final: join(work, 'final.json') };
await writeFile(files.schema, JSON.stringify(OUTPUT_SCHEMA));
const question = '用联网搜索查一下 nodejs.org 当前列出的最新 LTS 版本号，回答版本号和来源网址。如果你没有联网搜索工具，只回答“不能联网”。';
const models = { claude: 'haiku', codex: 'gpt-6-luna' };
let failed = false;

async function ask(provider, webSearch) {
  const config = { provider, workDir: work, readDir: work, timeoutMs: 240000, model: models[provider], effort: 'low', webSearch };
  await rm(files.final, { force: true });
  const args = buildArgs(config, files);
  // Claude Code: the same call, but with every event printed, so the tools it used can be counted.
  if (provider === 'claude') { args[args.indexOf('--output-format') + 1] = 'stream-json'; args.push('--verbose'); }
  const result = await runProcess(provider, args, { cwd: work, input: question + '\n', timeoutMs: config.timeoutMs, env: subscriptionEnv() });
  const final = provider === 'codex' ? await readFile(files.final, 'utf8').catch(() => undefined) : undefined;
  let reply = '', searched = 0;
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const stdout = provider === 'claude' ? JSON.stringify(events.findLast(event => event.type === 'result') ?? {}) : result.stdout;
  try { reply = parseOutput(provider, stdout, final).reply; } catch (error) { reply = `（无法解析：${error.message}）exit ${result.exitCode} ${result.stderr.slice(-300)}`; }
  if (provider === 'claude') {
    const ids = new Set();
    for (const event of events) for (const block of event.type === 'assistant' ? event.message?.content ?? [] : []) {
      if ((block.type === 'tool_use' || block.type === 'server_tool_use') && /^(WebSearch|WebFetch|web_search|web_fetch)$/.test(block.name)) ids.add(block.id);
    }
    searched = ids.size;
  } else {
    searched = result.stdout.split(/\r?\n/).filter(line => /"type":"web_search/.test(line)).length;
  }
  console.log(`${provider} search ${webSearch ? 'on ' : 'off'}: searches ${searched} | ${reply.replace(/\s+/g, ' ').slice(0, 160)}`);
  return { searched, reply };
}

try {
  for (const provider of process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex']) {
    const on = await ask(provider, true);
    const off = await ask(provider, false);
    const checks = {
      [`${provider}: with search on, a search ran and the answer cites a source`]: on.searched > 0 && /https?:\/\//.test(on.reply),
      [`${provider}: with search off, no search ran and it says so`]: off.searched === 0 && /不能联网/.test(off.reply),
    };
    for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
  }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
