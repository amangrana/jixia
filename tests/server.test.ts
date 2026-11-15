import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { resolveConfig } from '../src/config.ts';
import { Groups } from '../src/groups.ts';
import { startServer } from '../src/server.ts';
import { createQuotaMonitor } from '../src/quota.ts';
import type { LoginStatus } from '../src/auth.ts';
import type { Bot } from '../src/scheduler.ts';

// A real HTTP + WebSocket server on a random port, with mock bots. No model calls.

type Json = Record<string, any>;
const subscription: LoginStatus = { kind: 'subscription', detail: '订阅登录' };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
  for (let waited = 0; waited < 5000; waited += 10) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

// Tests in this file run one at a time, so one list of open servers is enough.
const closers: (() => Promise<void>)[] = [];
async function start(t: { after: (fn: () => Promise<void>) => void }, options: { bots?: Record<string, Bot>; config?: Json; logins?: Record<string, LoginStatus>; root?: string; models?: Record<string, any> } = {}) {
  const root = options.root ?? await mkdtemp(join(process.cwd(), '.server-test-'));
  if (!options.root) {
    // Runs after the hooks registered below, so every server on this root is
    // closed first. A group may still be saving its last answer when the test
    // ends, so removal retries rather than fail on a file that just appeared.
    t.after(async () => { await Promise.all(closers.splice(0).map(close => close())); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
    await mkdir(join(root, 'prompts'));
    await writeFile(join(root, 'prompts', 'system.md'), '你是 {{self}}');
  }
  const groups = await Groups.open({ root, config: resolveConfig(options.config), logins: options.logins ?? { claude: subscription, chatgpt: subscription }, bots: options.bots, models: options.models });
  const server = await startServer({ groups, port: 0 });
  const events: Json[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; socket.terminate(); await server.close(); };
  closers.push(close);
  t.after(close);
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  };
  const newGroup = async (name = '测试群') => (await api('POST', '/api/groups', { name })).body.group.id as string;
  return { root, port: server.port, events, api, newGroup, close };
}
const echo = (name: string): Bot => async input => `${name}:${input.message.content}`;

test('a message goes in over HTTP and every step comes back over the WebSocket, in order', async t => {
  const app = await start(t, { bots: { claude: echo('claude'), chatgpt: echo('chatgpt') } });
  const id = await app.newGroup('第一个群');
  assert.deepEqual((await app.api('GET', '/api/groups')).body.groups.map((g: Json) => [g.id, g.name]), [[id, '第一个群']]);
  assert.deepEqual((await app.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '大家好' })).status, 202);
  await until(() => app.events.some(e => e.type === 'round' && e.round === null), 'round to finish');
  const seen = app.events.filter(e => e.group === id).map(e => e.type === 'queue' ? `queue:${e.queue.length}` : e.type === 'round' ? `round:${e.round ? e.round.pending.length : 'done'}` : `${e.type}:${e.message.from}`);
  assert.deepEqual(seen.slice(0, 4), ['queue:1', 'queue:0', 'message:user', 'round:2']);
  assert.deepEqual(seen.slice(4).filter(s => s.startsWith('round')), ['round:1', 'round:0', 'round:done']);
  assert.deepEqual(seen.filter(s => s.startsWith('message')).sort(), ['message:chatgpt', 'message:claude', 'message:user']);
  assert(app.events.some(e => e.type === 'groups' && e.groups.length === 1));
  const state = (await app.api('GET', `/api/groups/${id}`)).body;
  assert.equal(state.group.name, '第一个群');
  assert.deepEqual(state.records.map((r: Json) => [r.seq, r.type]), [[1, 'user'], [2, 'reply'], [3, 'reply']]);
  assert.deepEqual([state.queue, state.round, state.hasMore], [[], null, false]);
  // Sending the same message again (a retry after a lost response) does not queue it twice.
  assert.deepEqual((await app.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '大家好' })).body, { queued: false });
  assert.equal((await app.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '换了内容' })).body.code, 'id-reused');
});

test('queued messages can be removed and moved to the top; a started message cannot', async t => {
  const gate = deferred<string>();
  const order: string[] = [];
  const app = await start(t, { bots: { claude: async input => { order.push(input.message.id); return input.message.id === 'm1' ? gate.promise : 'ok'; } } , config: { bots: { claude: { provider: 'claude' } } } });
  const id = await app.newGroup();
  for (const m of ['m1', 'm2', 'm3', 'm4']) await app.api('POST', `/api/groups/${id}/messages`, { id: m, content: `内容 ${m}` });
  await until(() => order.length === 1, 'first round to start');
  const state = (await app.api('GET', `/api/groups/${id}`)).body;
  assert.deepEqual(state.queue.map((m: Json) => m.id), ['m2', 'm3', 'm4']);
  assert.deepEqual(state.round, { messageId: 'm1', userSeq: 1, pending: ['claude'] });
  // Edit and delete both use DELETE: the accepted text comes back for the input box.
  const removed = await app.api('DELETE', `/api/groups/${id}/queue/m3`);
  assert.deepEqual([removed.status, removed.body.message.content], [200, '内容 m3']);
  assert.deepEqual((await app.api('POST', `/api/groups/${id}/queue/m4/top`)).body.queue.map((m: Json) => m.id), ['m4', 'm2']);
  for (const attempt of [await app.api('DELETE', `/api/groups/${id}/queue/m1`), await app.api('POST', `/api/groups/${id}/queue/m1/top`), await app.api('DELETE', `/api/groups/${id}/queue/m3`)]) {
    assert.deepEqual([attempt.status, attempt.body.code, attempt.body.error], [409, 'not-queued', '消息已开始处理']);
  }
  gate.resolve('done');
  await until(() => order.length === 3, 'queue to drain');
  assert.deepEqual(order, ['m1', 'm4', 'm2']);
});

test('bad requests get a specific status and code, and nothing is queued', async t => {
  const app = await start(t, { bots: { claude: echo('claude') }, config: { bots: { claude: { provider: 'claude' } }, maxMessageTokens: 50 } });
  const id = await app.newGroup();
  const check = async (response: Promise<{ status: number; body: Json }>, status: number, code: string) => { const got = await response; assert.deepEqual([got.status, got.body.code], [status, code]); };
  await check(app.api('POST', `/api/groups/${id}/messages`, { id: 'big', content: '很长的消息'.repeat(40) }), 413, 'message-too-long');
  await check(app.api('POST', `/api/groups/${id}/messages`, { id: 'm', content: '   ' }), 400, 'bad-request');
  await check(app.api('POST', `/api/groups/${id}/messages`, { content: '没有 id' }), 400, 'bad-request');
  await check(app.api('POST', `/api/groups/${id}/messages`, '{not json'), 400, 'bad-request');
  await check(app.api('POST', '/api/groups', { name: '' }), 400, 'bad-request');
  await check(app.api('GET', '/api/groups/00000000-0000-4000-8000-000000000000'), 404, 'group-not-found');
  await check(app.api('GET', '/api/groups/..%2F..%2Fsecrets'), 404, 'group-not-found');
  await check(app.api('GET', '/api/nothing'), 404, 'bad-request');
  const state = (await app.api('GET', `/api/groups/${id}`)).body;
  assert.deepEqual([state.records.length, state.queue.length], [0, 0]);
});

test('requests from another site are refused, for HTTP and for the WebSocket', async t => {
  const app = await start(t, { bots: { claude: echo('claude') }, config: { bots: { claude: { provider: 'claude' } } } });
  assert.equal((await app.api('GET', '/api/groups', undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.api('POST', '/api/groups', { name: 'x' }, { origin: 'http://127.0.0.1.evil.example' })).status, 403);
  // A page served from this machine on another port (the dev server) is fine.
  assert.equal((await app.api('GET', '/api/groups', undefined, { origin: 'http://localhost:5173' })).status, 200);
  const outcome = await new Promise<string>(resolve => {
    const socket = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { origin: 'https://evil.example' });
    socket.once('open', () => { socket.terminate(); resolve('open'); });
    socket.once('error', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
  assert.deepEqual((await app.api('GET', '/api/groups')).body.groups, []);
});

test('older records are fetched in pages', async t => {
  const app = await start(t, { bots: { claude: echo('claude') }, config: { bots: { claude: { provider: 'claude' } } } });
  const id = await app.newGroup();
  for (const m of ['a', 'b', 'c']) await app.api('POST', `/api/groups/${id}/messages`, { id: m, content: m });
  await until(async () => (await app.api('GET', `/api/groups/${id}`)).body.records.length === 6, 'three rounds');
  const tail = (await app.api('GET', `/api/groups/${id}?limit=2`)).body;
  assert.deepEqual([tail.records.map((r: Json) => r.seq), tail.hasMore], [[5, 6], true]);
  const page = (await app.api('GET', `/api/groups/${id}/records?before=5&limit=3`)).body;
  assert.deepEqual([page.records.map((r: Json) => r.seq), page.hasMore], [[2, 3, 4], true]);
  assert.deepEqual((await app.api('GET', `/api/groups/${id}/records?before=2`)).body, { records: [(await app.api('GET', `/api/groups/${id}`)).body.records[0]], hasMore: false });
  assert.equal((await app.api('GET', `/api/groups/${id}/records`)).status, 400);
});

test('a group that stopped after a storage failure reopens on the next request and carries on', async t => {
  const gate = deferred<string>(), started = deferred<void>();
  const app = await start(t, { bots: { claude: async input => { if (input.message.id !== 'm1') return 'ok'; started.resolve(); return gate.promise; } }, config: { bots: { claude: { provider: 'claude' } } } });
  const id = await app.newGroup();
  const directory = join(app.root, 'data', 'groups', id);
  await app.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '第一条' });
  await started.promise;
  await rename(directory, directory + '-away'); // Saving the answer will fail.
  gate.resolve('lost');
  await until(() => app.events.some(e => e.group === id && e.type === 'error'), 'the storage error to be reported');
  await rename(directory + '-away', directory);
  assert.equal((await app.api('POST', `/api/groups/${id}/messages`, { id: 'm2', content: '第二条' })).status, 202);
  await until(async () => (await app.api('GET', `/api/groups/${id}`)).body.records.length === 4, 'the second message to be answered');
  const records = (await app.api('GET', `/api/groups/${id}`)).body.records;
  assert.deepEqual(records.map((r: Json) => [r.seq, r.type]), [[1, 'user'], [2, 'failure'], [3, 'user'], [4, 'reply']]);
  assert.match(records[1].content, /回答中断/);
});

test('groups, history and queued messages survive a restart, and the queue resumes by itself', async t => {
  const gate = deferred<string>(), started = deferred<void>();
  const first = await start(t, { bots: { claude: async () => { started.resolve(); return gate.promise; } }, config: { bots: { claude: { provider: 'claude' } } } });
  const id = await first.newGroup('会重启的群');
  await first.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '被中断的' });
  await first.api('POST', `/api/groups/${id}/messages`, { id: 'm2', content: '排队中的' });
  await started.promise;
  await first.close(); // The round is still running when the app goes away.
  const second = await start(t, { root: first.root, bots: { claude: echo('claude') }, config: { bots: { claude: { provider: 'claude' } } } });
  assert.deepEqual((await second.api('GET', '/api/groups')).body.groups.map((g: Json) => g.name), ['会重启的群']);
  await until(async () => (await second.api('GET', `/api/groups/${id}`)).body.records.length === 4, 'the queued message to be processed after restart');
  const records = (await second.api('GET', `/api/groups/${id}`)).body.records;
  assert.deepEqual(records.map((r: Json) => [r.type, r.content.slice(0, 12)]), [['user', '被中断的'], ['failure', '回答中断：应用已重启'], ['user', '排队中的'], ['reply', 'claude:排队中的']]);
  gate.resolve('too late');
});

test('a bot whose CLI is not on a subscription login is never started, and says why', async t => {
  // No mock bots here: these are the real CLI-backed bots, both disabled by the login check.
  const app = await start(t, { logins: { claude: { kind: 'api-key', detail: 'Claude Code 的登录方式是 console，不是订阅' }, chatgpt: { kind: 'unknown', detail: 'Codex 的登录类型无法确认' } } });
  assert.deepEqual((await app.api('GET', '/api/status')).body.bots.map((b: Json) => [b.name, b.provider, b.enabled, b.login.kind]), [['claude', 'claude', false, 'api-key'], ['chatgpt', 'codex', false, 'unknown']]);
  const id = await app.newGroup();
  await app.api('POST', `/api/groups/${id}/messages`, { id: 'm1', content: '有人吗' });
  await until(async () => (await app.api('GET', `/api/groups/${id}`)).body.round === null && (await app.api('GET', `/api/groups/${id}`)).body.records.length === 3, 'both bots to be refused');
  const records = (await app.api('GET', `/api/groups/${id}`)).body.records;
  assert.deepEqual(records.slice(1).map((r: Json) => r.type), ['failure', 'failure']);
  assert.match(records.find((r: Json) => r.from === 'claude').content, /claude 未启用：Claude Code 的登录方式是 console，不是订阅/);
  assert.match(records.find((r: Json) => r.from === 'chatgpt').content, /requireSubscription/);
});

test('the built web page is served next to the API, and nothing outside its folder', async t => {
  const root = await mkdtemp(join(process.cwd(), '.server-test-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'system.md'), 'SECRET-OUTSIDE-DIST');
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<!doctype html><title>jixia</title>');
  await writeFile(join(root, 'dist', 'assets', 'app-abc123.js'), 'console.log("页面")');
  const groups = await Groups.open({ root, config: resolveConfig({}), logins: {}, bots: { claude: echo('claude'), chatgpt: echo('chatgpt') } });
  const withPage = await startServer({ groups, port: 0, staticDir: join(root, 'dist') });
  const bare = await startServer({ groups, port: 0, staticDir: join(root, 'not-built') });
  t.after(async () => { await withPage.close(); await bare.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const get = async (server: { port: number }, path: string, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method });
    return { status: response.status, type: response.headers.get('content-type') ?? '', cache: response.headers.get('cache-control'), text: await response.text() };
  };
  const home = await get(withPage, '/');
  assert.deepEqual([home.status, home.type, home.cache], [200, 'text/html; charset=utf-8', 'no-cache']);
  assert.match(home.text, /<title>jixia<\/title>/);
  const script = await get(withPage, '/assets/app-abc123.js');
  assert.deepEqual([script.status, script.type, script.text], [200, 'text/javascript; charset=utf-8', 'console.log("页面")']);
  assert.match(script.cache!, /immutable/);
  // Unknown paths get the page, never a file from outside the build folder.
  for (const path of ['/some/page', '/..%2Fprompts%2Fsystem.md', '/%2e%2e/prompts/system.md', '/assets/..%5C..%5Cprompts%5Csystem.md']) {
    const got = await get(withPage, path);
    assert(!got.text.includes('SECRET-OUTSIDE-DIST'), path);
    assert([200, 403].includes(got.status), path);
  }
  assert.equal((await get(withPage, '/', 'POST')).status, 405);
  assert.equal((await get(withPage, '/api/groups')).type, 'application/json; charset=utf-8');
  const missing = await get(bare, '/');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /npm run build/);
});

test('memory written in one group is announced there and visible to another group', async t => {
  const prompts: string[] = [];
  const app = await start(t, { bots: { claude: async input => { prompts.push(input.prompt!); return input.message.id === 'remember' ? { reply: '好', memoryRequests: [{ target: 'common', op: 'append', content: '喜欢乌龙茶' }] } : '嗯'; } }, config: { bots: { claude: { provider: 'claude' } } } });
  const a = await app.newGroup('甲'), b = await app.newGroup('乙');
  await app.api('POST', `/api/groups/${a}/messages`, { id: 'remember', content: '记住这个：我喜欢乌龙茶' });
  await until(() => app.events.some(e => e.group === a && e.type === 'message' && e.message.type === 'notice'), 'the memory notice');
  assert.match(await readFile(join(app.root, 'data', 'memory', 'common.md'), 'utf8'), /^\[\d{4}-\d{2}-\d{2}\] 喜欢乌龙茶\n$/);
  await until(() => app.events.some(e => e.group === a && e.type === 'round' && e.round === null), 'round a');
  await app.api('POST', `/api/groups/${b}/messages`, { id: 'ask', content: '我喜欢什么' });
  await until(() => prompts.length === 2, 'the other group to be asked');
  assert(prompts[1].includes('喜欢乌龙茶') && !prompts[1].includes('记住这个'));
});

test('each group has its own model choice: defaults for a new group, changes apply to queued messages, and it survives a restart', async t => {
  const used: string[] = [];
  const gate = deferred<void>(), started = deferred<void>();
  const claude: Bot = async input => {
    if (input.message.id === 'slow') { started.resolve(); await gate.promise; }
    used.push(`${input.message.id}:${input.model ?? '-'}/${input.effort ?? '-'}`);
    return { reply: 'ok', model: input.model ?? '默认模型', effort: input.effort };
  };
  const config = { bots: { claude: { provider: 'claude', model: 'sonnet', effort: 'low' } } };
  const models = { claude: { models: [{ id: 'sonnet', name: 'Sonnet', efforts: ['low', 'high'] }, { id: 'opus', name: 'Opus', efforts: ['low', 'high', 'max'] }, { id: 'haiku', name: 'Haiku', efforts: [] }], defaultEfforts: ['low', 'high'] } };
  const app = await start(t, { bots: { claude }, config, models });
  assert.deepEqual((await app.api('GET', '/api/status')).body.bots[0].models, models.claude);
  const a = await app.newGroup('甲'), b = await app.newGroup('乙');
  assert.deepEqual((await app.api('GET', `/api/groups/${a}`)).body.selection, { claude: { model: 'sonnet', effort: 'low' } });

  // One round is running and one message is queued when the choice changes.
  await app.api('POST', `/api/groups/${a}/messages`, { id: 'slow', content: '第一条' });
  await started.promise;
  await app.api('POST', `/api/groups/${a}/messages`, { id: 'queued', content: '排队的' });
  const changed = await app.api('PUT', `/api/groups/${a}/models/claude`, { model: 'opus', effort: 'max' });
  assert.deepEqual([changed.status, changed.body.selection], [200, { claude: { model: 'opus', effort: 'max' } }]);
  assert(app.events.some(e => e.group === a && e.type === 'selection' && e.selection.claude.model === 'opus'));
  gate.resolve();
  await app.api('POST', `/api/groups/${b}/messages`, { id: 'other', content: '另一个群' });
  await until(() => used.length === 3, 'all three rounds');
  // The running round keeps what it started with; the queued one gets the new choice; the other group is untouched.
  assert.deepEqual([...used].sort(), ['other:sonnet/low', 'queued:opus/max', 'slow:sonnet/low']);
  await until(async () => (await app.api('GET', `/api/groups/${a}`)).body.records.length === 4, 'answers recorded');
  assert.deepEqual((await app.api('GET', `/api/groups/${a}`)).body.records.filter((r: Json) => r.type === 'reply').map((r: Json) => [r.model, r.effort]), [['sonnet', 'low'], ['opus', 'max']]);

  // Back to "let the CLI decide", and refusals that change nothing.
  assert.deepEqual((await app.api('PUT', `/api/groups/${b}/models/claude`, { model: null, effort: null })).body.selection, { claude: {} });
  for (const [bot, body, why] of [['claude', { model: 'gpt-x' }, /模型列表里没有 gpt-x/], ['claude', { model: 'haiku', effort: 'low' }, /haiku 不支持 effort low/], ['claude', { effort: 'max' }, /默认模型 不支持 effort max/], ['claude', { model: 'a b' }, /名称/], ['claude', { model: 5 }, /名称/], ['nobody', { model: 'opus' }, /没有名为 nobody 的 bot/]] as const) {
    const refused = await app.api('PUT', `/api/groups/${b}/models/${bot}`, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.match(refused.body.error, why);
  }
  assert.equal((await app.api('PUT', '/api/groups/00000000-0000-4000-8000-000000000000/models/claude', { model: 'opus' })).status, 404);
  assert.deepEqual((await app.api('GET', `/api/groups/${b}`)).body.selection, { claude: {} });

  await app.close();
  // After a restart with different defaults, both groups keep what they had.
  const again = await start(t, { root: app.root, bots: { claude }, config: { bots: { claude: { provider: 'claude', model: 'haiku' } } }, models });
  assert.deepEqual((await again.api('GET', `/api/groups/${a}`)).body.selection, { claude: { model: 'opus', effort: 'max' } });
  assert.deepEqual((await again.api('GET', `/api/groups/${b}`)).body.selection, { claude: {} });
  assert.deepEqual((await again.api('GET', `/api/groups/${await again.newGroup('丙')}`)).body.selection, { claude: { model: 'haiku' } });
});

test('a group can be deleted: its folder moves to data/deleted, and a group that is answering cannot be deleted', async t => {
  const gate = deferred<string>(), started = deferred<void>();
  const app = await start(t, { bots: { claude: async input => { if (input.message.id !== 'slow') return 'ok'; started.resolve(); return gate.promise; } }, config: { bots: { claude: { provider: 'claude' } } } });
  const keep = await app.newGroup('留着'), gone = await app.newGroup('要删');
  await app.api('POST', `/api/groups/${gone}/messages`, { id: 'slow', content: '慢的' });
  await app.api('POST', `/api/groups/${gone}/messages`, { id: 'queued', content: '排队的' });
  await started.promise;
  assert.equal((await app.api('GET', `/api/groups/${gone}`)).body.messageCount, 1);
  // Answering: refused, and nothing changes.
  const busy = await app.api('DELETE', `/api/groups/${gone}`);
  assert.deepEqual([busy.status, busy.body.code], [409, 'group-busy']);
  assert.match(busy.body.error, /正在回答/);
  gate.resolve('done');
  // The queued message runs next; delete as soon as the group is between rounds.
  let deleted: Awaited<ReturnType<typeof app.api>> | undefined;
  await until(async () => (deleted = await app.api('DELETE', `/api/groups/${gone}`)).status === 200, 'the group to be deletable');
  assert.equal(deleted!.body.group.name, '要删');
  assert.deepEqual((await app.api('GET', '/api/groups')).body.groups.map((g: Json) => g.name), ['留着']);
  assert(app.events.some(e => e.type === 'groups' && e.groups.length === 1));
  assert.equal((await app.api('GET', `/api/groups/${gone}`)).status, 404);
  assert.equal((await app.api('POST', `/api/groups/${gone}/messages`, { id: 'late', content: '晚了' })).status, 404);
  assert.equal((await app.api('DELETE', `/api/groups/${gone}`)).status, 404);
  // Moved, not erased; the other group is untouched and still works.
  assert((await readFile(join(app.root, 'data', 'deleted', gone, 'events.jsonl'), 'utf8')).includes('慢的'));
  await assert.rejects(readFile(join(app.root, 'data', 'groups', gone, 'group.json'), 'utf8'), /ENOENT/);
  await app.api('POST', `/api/groups/${keep}/messages`, { id: 'k1', content: '还在' });
  await until(async () => (await app.api('GET', `/api/groups/${keep}`)).body.records.length === 2, 'the other group to answer');
  // After a restart the deleted group stays gone.
  await app.close();
  const again = await start(t, { root: app.root, bots: { claude: async () => 'ok' }, config: { bots: { claude: { provider: 'claude' } } } });
  assert.deepEqual((await again.api('GET', '/api/groups')).body.groups.map((g: Json) => g.name), ['留着']);
});

test('quota readings are served, refreshed on request and pushed over the WebSocket', async t => {
  const root = await mkdtemp(join(process.cwd(), '.server-test-'));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'system.md'), '你是 {{self}}');
  let used = 10;
  const monitor = createQuotaMonitor({ providers: ['claude'], deps: {
    run: async () => ({ stdout: JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: { utilization: used }, seven_day: { utilization: 5 } } } } }), exitCode: 0, timedOut: false }),
    openCodex: async () => { throw new Error('not used'); },
  } });
  await monitor.refresh();
  const groups = await Groups.open({ root, config: resolveConfig({ bots: { claude: { provider: 'claude' } } }), logins: {}, bots: { claude: echo('claude') } });
  const server = await startServer({ groups, port: 0, quota: monitor });
  const events: Json[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise(resolve => socket.once('open', resolve));
  t.after(async () => { socket.terminate(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const call = async (method: string, path: string) => (await fetch(`http://127.0.0.1:${server.port}${path}`, { method })).json() as Promise<Json>;
  assert.equal((await call('GET', '/api/quota')).quotas.claude.quota.fiveHour.usedPercent, 10);
  used = 42;
  assert.equal((await call('POST', '/api/quota/refresh')).quotas.claude.quota.fiveHour.usedPercent, 42);
  await until(() => events.some(e => e.type === 'quota' && e.quotas.claude.quota.fiveHour.usedPercent === 42), 'the new reading to be pushed');
});
