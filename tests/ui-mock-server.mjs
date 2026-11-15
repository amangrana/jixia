// The real backend and the built web page, with scripted bots instead of the
// CLIs. For looking at the UI without spending quota. Data goes to a throwaway
// folder that is removed on exit.
//   npm run build
//   node tests/ui-mock-server.mjs [port]
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { startServer } from '../src/server.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'jixia-ui-'));
await mkdir(join(root, 'prompts'));
await writeFile(join(root, 'prompts', 'system.md'), '你是 {{self}}');
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
const config = resolveConfig({});
const groups = await Groups.open({
  root, config,
  logins: Object.fromEntries(Object.keys(config.bots).map(name => [name, { kind: 'subscription', detail: '模拟 bot' }])),
  bots: { claude: bot('claude', 900), chatgpt: bot('chatgpt', 1800) },
});
const server = await startServer({ groups, port: Number(process.argv[2] ?? 4599), staticDir: join(project, 'web', 'dist') });
console.log(`jixia UI (mock bots): http://127.0.0.1:${server.port}`);
const stop = async () => { await server.close(); await rm(root, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
