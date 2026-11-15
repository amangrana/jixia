import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPreparer } from '../src/context.ts';
import { createMemoryWriter } from '../src/memory.ts';
import type { MemoryRequest } from '../src/memory.ts';
import { Scheduler } from '../src/scheduler.ts';

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.cwd(), '.memory-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = { commonPath: join(directory, 'common.md'), selfPath: (bot: string) => join(directory, `${bot}.md`), defaultWriter: 'claude', now: () => new Date(2026, 10, 15, 23, 30) };
  const read = (name: string) => readFile(join(directory, name), 'utf8').catch(() => undefined);
  return { directory, files, read };
}
const request = (target: 'common' | 'self', content: string): MemoryRequest => ({ target, op: 'append', content });
const both = ['claude', 'chatgpt'];

test('the designated writer appends a dated entry to common memory; a bot appends to its own file', async t => {
  const { directory, files, read } = await workspace(t);
  await writeFile(join(directory, 'common.md'), '[2026-11-10] 旧条目'); // No trailing newline.
  const apply = createMemoryWriter(files);
  assert.deepEqual(await apply({ bot: 'claude', targets: both, requests: [request('common', '  偏好简短回答\n'), request('self', '负责写代码')] }),
    ['claude 写入了公共记忆：偏好简短回答', 'claude 写入了自己的记忆：负责写代码']);
  assert.equal(await read('common.md'), '[2026-11-10] 旧条目\n[2026-11-15] 偏好简短回答\n');
  assert.equal(await read('claude.md'), '[2026-11-15] 负责写代码\n');
  assert.equal(await read('common.md.tmp'), undefined);
});

test('only this round\'s writer may write common memory; everyone else is refused with a notice', async t => {
  const { files, read } = await workspace(t);
  const apply = createMemoryWriter(files);
  assert.deepEqual(await apply({ bot: 'chatgpt', targets: both, requests: [request('common', '想写公共记忆'), request('self', '自己的可以写')] }),
    ['已拒绝 chatgpt 写入公共记忆：本轮的写入者是 claude', 'chatgpt 写入了自己的记忆：自己的可以写']);
  assert.equal(await read('common.md'), undefined);
  // A message that names only chatgpt makes it the writer for that round, and claude is refused.
  assert.deepEqual(await apply({ bot: 'chatgpt', targets: ['chatgpt'], requests: [request('common', '被点名后可以写')] }), ['chatgpt 写入了公共记忆：被点名后可以写']);
  assert.deepEqual(await apply({ bot: 'claude', targets: ['chatgpt'], requests: [request('common', '不该写入')] }), ['已拒绝 claude 写入公共记忆：本轮的写入者是 chatgpt']);
  assert.equal(await read('common.md'), '[2026-11-15] 被点名后可以写\n');
});

test('empty content and operations other than append are refused', async t => {
  const { files, read } = await workspace(t);
  const apply = createMemoryWriter(files);
  const replace = { target: 'common', op: 'replace', content: '整份改写' } as unknown as MemoryRequest;
  assert.deepEqual(await apply({ bot: 'claude', targets: both, requests: [request('common', '   '), replace] }),
    ['已拒绝 claude 写入公共记忆：内容为空', '已拒绝 claude 写入公共记忆：第一版只接受追加']);
  assert.equal(await read('common.md'), undefined);
});

test('parallel writes from different groups all land, in order, without losing an entry', async t => {
  const { files, read } = await workspace(t);
  const apply = createMemoryWriter(files);
  await Promise.all(Array.from({ length: 20 }, (_, index) => apply({ bot: 'claude', targets: both, requests: [request('common', `条目${index}`)] })));
  assert.deepEqual((await read('common.md'))!.trim().split('\n'), Array.from({ length: 20 }, (_, index) => `[2026-11-15] 条目${index}`));
});

test('a file that grows past the limit gets a tidy-up notice, and a write error is reported, not thrown', async t => {
  const { directory, files, read } = await workspace(t);
  const apply = createMemoryWriter({ ...files, maxMemoryTokens: 10 });
  const notices = await apply({ bot: 'claude', targets: both, requests: [request('common', '这是一条比较长的记忆内容')] });
  assert.equal(notices.length, 2);
  assert.match(notices[1], /公共记忆已有约 \d+ token，超过 10，建议整理这个文件/);
  assert.equal(await read('common.md'), '[2026-11-15] 这是一条比较长的记忆内容\n'); // Still written.
  await mkdir(join(directory, 'claude.md')); // Unwritable target.
  const failed = await apply({ bot: 'claude', targets: both, requests: [request('self', '写不进去')] });
  assert.equal(failed.length, 1);
  assert.match(failed[0], /claude 写入自己的记忆失败/);
});

test('in the group: writes are announced after the reply, the same round does not see them, the next round does', async t => {
  const { directory, files, read } = await workspace(t);
  await writeFile(join(directory, 'system.md'), '你是 {{self}}');
  const prompts: Record<string, string[]> = { claude: [], chatgpt: [] };
  const bot = (name: string) => async (input: { prompt?: string; message: { id: string } }) => {
    prompts[name].push(input.prompt!);
    if (input.message.id !== 'm1') return `${name} 第二轮`;
    // chatgpt answers a little later, after claude's write has already happened.
    if (name === 'chatgpt') await new Promise(resolve => setTimeout(resolve, 50));
    return { reply: `${name} 记下了`, memoryRequests: [request('common', `${name} 记的：喜欢乌龙茶`)] };
  };
  const prepare = createPreparer({ systemPath: join(directory, 'system.md'), commonPath: files.commonPath, selfPath: files.selfPath, summaryPath: join(directory, 'summary.md'), recordsPath: 'r', bots: both, defaultWriter: 'claude' });
  let scheduler = await Scheduler.open(join(directory, 'group'), { claude: bot('claude'), chatgpt: bot('chatgpt') }, { prepare, applyMemory: createMemoryWriter(files) });
  await scheduler.enqueue({ id: 'm1', content: '记住这个：我喜欢乌龙茶' });
  await scheduler.enqueue({ id: 'm2', content: '我喜欢什么茶' });
  await scheduler.runUntilIdle();
  assert.equal(await read('common.md'), '[2026-11-15] claude 记的：喜欢乌龙茶\n');
  assert.deepEqual(scheduler.history.slice(0, 5).map(m => [m.seq, m.from, m.type, m.content]), [
    [1, 'user', 'user', '记住这个：我喜欢乌龙茶'],
    [2, 'claude', 'reply', 'claude 记下了'],
    [3, 'system', 'notice', 'claude 写入了公共记忆：claude 记的：喜欢乌龙茶'],
    [4, 'chatgpt', 'reply', 'chatgpt 记下了'],
    [5, 'system', 'notice', '已拒绝 chatgpt 写入公共记忆：本轮的写入者是 claude'],
  ]);
  assert.equal(scheduler.history[2].replyTo, 1);
  assert(!prompts.chatgpt[0].includes('乌龙茶\n[') && !prompts.chatgpt[0].includes('claude 记的'));
  // Next round: the memory section has the entry, and the notice is in the raw history as a system line.
  assert(prompts.chatgpt[1].includes('# 公共记忆\n[2026-11-15] claude 记的：喜欢乌龙茶'));
  assert(prompts.chatgpt[1].includes('{"seq":3,"from":"system","content":"claude 写入了公共记忆：claude 记的：喜欢乌龙茶"}'));
  // Notices are part of the journal and the readable records, and survive a reopen.
  const records = (await readFile(join(directory, 'group', 'records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records, scheduler.history);
  const before = scheduler.history;
  scheduler = await Scheduler.open(join(directory, 'group'), { claude: bot('claude'), chatgpt: bot('chatgpt') });
  assert.deepEqual(scheduler.history, before);
});

test('without a memory writer, requests are reported as ignored rather than dropped silently', async t => {
  const { directory, read } = await workspace(t);
  const scheduler = await Scheduler.open(join(directory, 'group'), { claude: async () => ({ reply: '好', memoryRequests: [request('common', 'x')] }) });
  await scheduler.enqueue({ id: 'm1', content: '记住这个', targets: ['claude'] });
  await scheduler.runUntilIdle();
  assert.deepEqual(scheduler.history.map(m => m.type), ['user', 'reply', 'notice']);
  assert.match(scheduler.history[2].content, /没有启用记忆写入，已忽略 claude 的 1 条写记忆请求/);
  assert.equal(await read('common.md'), undefined);
});
