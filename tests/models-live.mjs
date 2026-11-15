// Live check of model choice: the real startup query against both CLIs (no
// model call), then one round where each bot is given a model and an effort.
// Makes three short model calls and uses subscription quota. Not part of `npm test`.
//   node tests/models-live.mjs
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLogin } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { loadModels } from '../src/models.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(project, '.live-data-'));
await mkdir(join(root, 'prompts'));
await mkdir(join(root, 'data', 'work'), { recursive: true });
await copyFile(join(project, 'prompts', 'system.md'), join(root, 'prompts', 'system.md'));
let failed = false;
try {
  const started = Date.now();
  const models = await loadModels({ cachePath: join(root, 'data', 'models.json'), providers: ['claude', 'codex'], workDir: join(root, 'data', 'work') });
  const queryMs = Date.now() - started;
  for (const [provider, list] of Object.entries(models)) console.log(`${provider}: ${list.note ?? list.models.map(model => `${model.id}[${model.efforts.join(",")}]${model.defaultEffort ? `(default ${model.defaultEffort})` : ""}`).join("  ")}
  default model: ${JSON.stringify(list.defaultModel)}, default effort: ${list.defaultEffort}, efforts without a model: ${list.defaultEfforts.join(",")}`);

  const logins = { claude: await checkLogin('claude'), chatgpt: await checkLogin('codex') };
  const groups = await Groups.open({ root, config: resolveConfig({ cliTimeoutSeconds: 180 }), logins, models });
  const { id } = await groups.create('模型选择');
  // The smaller models, to keep this cheap.
  const pick = { claude: models.claude.models.find(model => model.id === 'haiku'), chatgpt: models.codex.models.find(model => /luna/.test(model.id)) };
  for (const [bot, model] of Object.entries(pick)) if (model) await groups.select(id, bot, { model: model.id, effort: model.efforts.includes('low') ? 'low' : undefined });
  console.log('selection:', JSON.stringify(groups.selection(id)));
  await groups.use(id, scheduler => scheduler.enqueue({ id: 'm1', content: '用一句话打个招呼。' }));
  await groups.use(id, scheduler => scheduler.runUntilIdle());
  const history = await groups.use(id, scheduler => scheduler.history);
  for (const message of history) console.log(JSON.stringify({ from: message.from, type: message.type, model: message.model, effort: message.effort, content: message.content }));
  const by = name => history.find(message => message.from === name);
  // A second group where chatgpt keeps the CLI default: its answer should name that default.
  const plain = (await groups.create('默认模型')).id;
  await groups.select(plain, 'chatgpt', { model: null, effort: null });
  await groups.use(plain, scheduler => scheduler.enqueue({ id: 'm2', content: '@chatgpt 只回复：好' }));
  await groups.use(plain, scheduler => scheduler.runUntilIdle());
  const plainReply = (await groups.use(plain, scheduler => scheduler.history)).find(message => message.from === 'chatgpt');
  console.log(JSON.stringify({ from: 'chatgpt (default)', type: plainReply?.type, model: plainReply?.model, content: plainReply?.content }));
  const checks = {
    'both CLIs named their default model': Boolean(models.claude.defaultModel && models.codex.defaultModel),
    'Codex named a default effort for its default model and for each model': Boolean(models.codex.defaultEffort) && models.codex.models.every(model => model.defaultEffort),
    'chatgpt with no model chosen records the default model by name': plainReply?.type === 'reply' && plainReply.model === models.codex.defaultModel?.id,
    'both model lists came from this start\'s query': !models.claude.note && !models.codex.note && models.claude.models.length > 0 && models.codex.models.length > 0,
    [`the two queries took under 15 seconds together (${queryMs} ms)`]: queryMs < 15000,
    'a small model was found for each bot': Boolean(pick.claude && pick.chatgpt),
    'claude answered with the chosen model': by('claude')?.type === 'reply' && /haiku/.test(by('claude').model ?? ''),
    'claude\'s answer carries the chosen effort': by('claude')?.effort === groups.selection(id).claude.effort,
    'chatgpt answered with the chosen model and effort': by('chatgpt')?.type === 'reply' && by('chatgpt').model === pick.chatgpt?.id && by('chatgpt').effort === 'low',
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
