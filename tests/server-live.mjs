// Live check of the backend service: real login check, real CLIs, real HTTP + WebSocket.
// Makes two short model calls and uses subscription quota. Not part of `npm test`.
// Uses a throwaway data folder, so your own groups and memory are untouched.
//   node tests/server-live.mjs
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { checkLogin } from '../src/auth.ts';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { startServer } from '../src/server.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
// Inside the jixia folder, with its own prompts/ and data/.
const root = await mkdtemp(join(project, '.live-data-'));
await mkdir(join(root, 'prompts'));
await copyFile(join(project, 'prompts', 'system.md'), join(root, 'prompts', 'system.md'));
const config = resolveConfig({ cliTimeoutSeconds: 180 });
const logins = { claude: await checkLogin('claude'), chatgpt: await checkLogin('codex') };
console.log('login check:', JSON.stringify(logins));
let failed = false, server;
try {
  const groups = await Groups.open({ root, config, logins });
  server = await startServer({ groups, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const events = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const { group } = await post('/api/groups', { name: '连通测试' });
  await post(`/api/groups/${group.id}/messages`, { id: 'm1', content: '用一句话打个招呼。' });
  const deadline = Date.now() + 200000;
  while (!events.some(e => e.type === 'round' && e.round === null) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  socket.terminate();
  const pushed = events.filter(e => e.type === 'message').map(e => e.message);
  for (const message of pushed) console.log(JSON.stringify({ seq: message.seq, from: message.from, type: message.type, model: message.model, content: message.content }));
  const state = await fetch(`${base}/api/groups/${group.id}`).then(r => r.json());
  const status = await fetch(`${base}/api/status`).then(r => r.json());
  const checks = {
    'both CLIs report a subscription login': logins.claude.kind === 'subscription' && logins.chatgpt.kind === 'subscription',
    'both bots are enabled': status.bots.every(bot => bot.enabled),
    'the round finished and was pushed over the WebSocket': events.some(e => e.type === 'round' && e.round === null),
    'claude answered': pushed.some(m => m.from === 'claude' && m.type === 'reply' && m.content.trim()),
    'chatgpt answered': pushed.some(m => m.from === 'chatgpt' && m.type === 'reply' && m.content.trim()),
    'claude\'s answer names the model Claude Code reported': /^claude-/.test(pushed.find(m => m.from === 'claude')?.model ?? ''),
    'chatgpt\'s answer says the default model was used': pushed.find(m => m.from === 'chatgpt')?.model === '默认模型',
    'the HTTP state matches what was pushed': JSON.stringify(state.records) === JSON.stringify([...pushed].sort((a, b) => a.seq - b.seq)) && state.round === null && state.queue.length === 0,
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
