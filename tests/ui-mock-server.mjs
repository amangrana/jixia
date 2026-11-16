// The real backend and the built web page, with scripted bots instead of the
// CLIs. For looking at the UI without spending quota. Data goes to a throwaway
// folder that is removed on exit.
//   npm run build
//   node tests/ui-mock-server.mjs [port]
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { startServer } from '../src/server.ts';
import { createQuotaMonitor } from '../src/quota.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'jixia-ui-'));
await mkdir(join(root, 'prompts'));
await writeFile(join(root, 'prompts', 'system.md'), '你是 {{self}}');
await copyFile(join(project, 'prompts', 'discussion.md'), join(root, 'prompts', 'discussion.md'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// What a bot does depends on words in the message, so each UI state can be reached by hand:
//   慢 -> answers after 8s, 很慢 -> after 40s (time to queue more messages)   失败 -> chatgpt fails
//   记住 -> a memory write and its notice                    格式 -> a Markdown-heavy answer
const bot = (name, delay) => async ({ message }) => {
  const text = message.content;
  await wait(text.includes('很慢') ? 40000 : text.includes('慢') ? 8000 : delay);
  if (text.includes('失败') && name === 'chatgpt') throw new Error('Codex 超过 300 秒没有回答，已终止');
  if (text.includes('记住')) return { reply: '好的，已提交写入请求。', memoryRequests: [{ target: 'common', op: 'append', content: text.replace(/^.*记住(这个)?[：:]?/, '').trim() || text }] };
  if (text.includes('格式')) return '## 小结\n\n两种方案的对比：\n\n| 方案 | 优点 | 缺点 |\n| --- | --- | --- |\n| 事件日志 | 单一事实来源 | 不直接可读 |\n| 两个文件 | 直观 | 有崩溃窗口 |\n\n- 第一点，带 `行内代码`\n- 第二点\n\n```ts\nconst retries = 2;\nawait scheduler.runUntilIdle();\n```\n\n> 引用：以磁盘上的事件为准。';
  return `我是 ${name}。你说的是：“${text}”`;
};
// Like the real adapter: the answer says which model and effort produced it.
// `fallback` stands for what the CLI would pick when the group chose nothing.
const named = (run, fallback) => async input => {
  const output = await run(input);
  return { ...(typeof output === 'string' ? { reply: output } : output), model: input.model ?? fallback, ...(input.effort ? { effort: input.effort } : {}) };
};
// A small made-up catalog, shaped like the startup query's result. chatgpt's carries a note, as after a failed query.
const MODELS = {
  claude: { defaultModel: { id: 'claude-opus-5-5', name: 'Opus 5.5' }, models: [{ id: 'fable', name: 'Fable 5.2', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] }], defaultEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { defaultModel: { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, defaultEffort: 'low', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' }, { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }], defaultEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], note: 'Codex 的模型列表没有更新（模拟），沿用 2026-11-14 查到的列表' },
};
const config = resolveConfig({});
const groups = await Groups.open({
  root, config,
  logins: Object.fromEntries(Object.keys(config.bots).map(name => [name, { kind: 'subscription', detail: '模拟 bot' }])),
  bots: { claude: named(bot('claude', 900), 'claude-fable-5-2'), chatgpt: named(bot('chatgpt', 1800), '默认模型') },
  models: MODELS,
});
// Made-up usage: claude reads fine and climbs each refresh; codex reads once, then fails, to show a kept reading.
let claudeUsed = 64, codexReads = 0;
const inHours = hours => new Date(Date.now() + hours * 3600_000).toISOString();
const quota = createQuotaMonitor({ providers: ['claude', 'codex'], deps: {
  run: async () => { claudeUsed = Math.min(100, claudeUsed + 13); return { stdout: JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: claudeUsed, resets_at: inHours(3) }, seven_day: { utilization: 15, resets_at: inHours(110) } } } } }), exitCode: 0, timedOut: false }; },
  openCodex: async () => ({ request: async method => { if (method === 'initialize') return {}; if (codexReads++) throw new Error('模拟：查询超时'); return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 7200 }, secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: Date.now() / 1000 + 400000 } } }; }, close: () => {} }),
} });
quota.start();
const server = await startServer({ groups, port: Number(process.argv[2] ?? 4599), staticDir: join(project, 'web', 'dist'), quota, onExit: () => void stop() });
console.log(`jixia UI (mock bots): http://127.0.0.1:${server.port}`);
const stop = async () => { await server.close(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
