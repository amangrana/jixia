// The full app with the real CLIs, for walking through the acceptance list by
// hand without touching your own data/. Same wiring as src/main.ts, except:
//   - data and prompts live in a separate folder (default .live-data-acceptance),
//     which is kept between runs so restarts can be checked; delete it when done
//   - small models and low effort are the defaults, to keep the quota cost down
//   - the compact threshold is low, so compaction happens within a short chat
// Every message spends subscription quota. Not part of `npm test`.
//   npm run build
//   node tests/acceptance-server.mjs [port] [folder] [break-models]
// `break-models` makes this start's model list query fail, to check the fallback.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLogin } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { loadModels } from '../src/models.ts';
import { startServer } from '../src/server.ts';

// When started from inside another Claude session, that session's variables
// would be inherited by the CLIs this app starts. A terminal has none of them.
for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = resolve(project, process.argv[3] ?? '.live-data-acceptance');
await mkdir(join(root, 'prompts'), { recursive: true });
await mkdir(join(root, 'data', 'work'), { recursive: true });
for (const name of ['system.md', 'compact.md']) await copyFile(join(project, 'prompts', name), join(root, 'prompts', name));

const config = resolveConfig({
  bots: { claude: { provider: 'claude', model: 'haiku', effort: 'low' }, chatgpt: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } },
  compact: { thresholdTokens: 2500, keepRounds: 3, maxSummaryTokens: 1500 },
  cliTimeoutSeconds: 180,
});
const logins = { claude: await checkLogin('claude'), chatgpt: await checkLogin('codex') };
const broken = process.argv[4] === 'break-models';
const models = await loadModels({
  cachePath: join(root, 'data', 'models.json'), providers: ['claude', 'codex'], workDir: join(root, 'data', 'work'),
  ...(broken ? { run: async () => { throw new Error('验收用：模拟查询失败'); } } : {}),
});
const groups = await Groups.open({ root, config, logins, models });
const server = await startServer({ groups, port: Number(process.argv[2] ?? 4600), staticDir: join(project, 'web', 'dist') });
console.log(`jixia acceptance (real bots, data in ${root}): http://127.0.0.1:${server.port}`);
for (const bot of groups.bots) console.log(`  ${bot.name}: ${bot.enabled ? 'enabled' : 'disabled'}, ${bot.login.detail}; ${bot.models.note ?? `${bot.models.models.length} models`}`);
