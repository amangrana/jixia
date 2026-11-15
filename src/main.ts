import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defaultRun, loadModels, openCodexAppServer } from './models.ts';
import { createQuotaMonitor } from './quota.ts';
import { fileURLToPath } from 'node:url';
import { checkLogin } from './auth.ts';
import { loadConfig } from './config.ts';
import { Groups } from './groups.ts';
import { startServer } from './server.ts';
import type { LoginStatus } from './auth.ts';
import type { Provider } from './cli.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = await loadConfig(join(root, 'config.yaml'));

// One check per CLI, shared by every bot that uses it.
const byProvider = new Map<Provider, Promise<LoginStatus>>();
const logins: Record<string, LoginStatus> = {};
for (const [name, bot] of Object.entries(config.bots)) {
  if (!byProvider.has(bot.provider)) byProvider.set(bot.provider, checkLogin(bot.provider));
  logins[name] = await byProvider.get(bot.provider)!;
}

// Also asked on every start: which models each CLI offers. No model is called.
const work = join(root, 'data', 'work');
await mkdir(work, { recursive: true });
const models = await loadModels({ cachePath: join(root, 'data', 'models.json'), providers: [...byProvider.keys()], workDir: work });

const groups = await Groups.open({ root, config, logins, models });
// Subscription usage, read now and every 5 minutes. No model is called.
// Only for CLIs on a subscription login: an API-key login has no such limits.
const quota = createQuotaMonitor({
  providers: [...byProvider.keys()].filter(provider => groups.bots.some(bot => bot.provider === provider && bot.login.kind === 'subscription')),
  deps: { run: defaultRun(work), openCodex: openCodexAppServer(work) },
});
quota.start();
const server = await startServer({ groups, port: config.port, staticDir: join(root, 'web', 'dist'), quota });
console.log(`jixia 已启动，在浏览器里打开：http://127.0.0.1:${server.port}`);
for (const bot of groups.bots) console.log(`  ${bot.name}（${bot.provider}）：${bot.enabled ? '已启用' : '未启用'}，${bot.login.detail}；${bot.models.note ?? `可选 ${bot.models.models.length} 个模型`}`);
