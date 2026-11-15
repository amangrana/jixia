import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemory, HISTORY_KEEP, MemoryChangedError } from '../src/memory.ts';
import { estimateTokens as backendEstimate } from '../src/tokens.ts';
import { estimateTokens, isDirty, loadLatest, memoryArrived } from '../web/src/state.ts';

// Viewing and editing memory in the app: the backend store, then the page's rules.

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.cwd(), '.memory-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const files = { commonPath: join(directory, 'common.md'), selfPath: (bot: string) => join(directory, `${bot}.md`), defaultWriter: 'claude', bots: ['claude', 'chatgpt'], now: () => new Date(2026, 10, 15, 23, 30) };
  const read = (name: string) => readFile(join(directory, name), 'utf8').catch(() => undefined);
  return { directory, files, read };
}
const append = (content: string) => ({ target: 'common' as const, op: 'append' as const, content });

test('every file is listed, common first, empty ones included; names that are not memory files are refused', async t => {
  const { directory, files } = await workspace(t);
  await writeFile(join(directory, 'common.md'), '[2026-11-10] 公共\n');
  const memory = createMemory(files);
  const listed = await memory.list();
  assert.deepEqual(listed.map(file => [file.name, file.content]), [['common', '[2026-11-10] 公共\n'], ['claude', ''], ['chatgpt', '']]);
  assert(listed.every(file => file.limit === 8000 && /^[0-9a-f]{16}$/.test(file.version)));
  assert.notEqual(listed[0].version, listed[1].version);
  for (const name of ['../secret', 'history', 'gemini']) await assert.rejects(memory.read(name), /没有名为/);
});

test('an edit is saved only onto the version it was made from; the old content is backed up first', async t => {
  const { directory, files, read } = await workspace(t);
  await writeFile(join(directory, 'common.md'), '[2026-11-10] 旧\n');
  const memory = createMemory(files);
  const changed: string[] = [];
  memory.subscribe(name => changed.push(name));
  const opened = await memory.read('common');

  const saved = await memory.save('common', '整理后的内容\n', opened.version);
  assert.equal(await read('common.md'), '整理后的内容\n');
  assert.equal(saved.version, (await memory.read('common')).version);
  const history = await readdir(join(directory, 'history'));
  assert.equal(history.length, 1);
  assert.match(history[0], /^common-\d{4}-\d\d-\d\dT[\d-]+Z\.md$/); // UTC time, so names sort by time.
  assert.equal(await readFile(join(directory, 'history', history[0]), 'utf8'), '[2026-11-10] 旧\n');

  // A bot writes after the page loaded the file: the stale edit is refused and nothing changes.
  await memory.apply({ bot: 'claude', targets: ['claude', 'chatgpt'], requests: [append('新的事实')] });
  const before = await read('common.md');
  await assert.rejects(memory.save('common', '用旧版本改的', saved.version), (error: unknown) => {
    assert(error instanceof MemoryChangedError);
    assert.equal(error.latest.content, before); // The current file comes back with the refusal.
    return true;
  });
  assert.equal(await read('common.md'), before);
  assert.deepEqual(changed, ['common', 'common']);

  // A file that does not exist yet is saved from the empty version, with nothing to back up.
  const empty = await memory.read('chatgpt');
  await memory.save('chatgpt', '[2026-11-15] 第一条\n', empty.version);
  assert.equal(await read('chatgpt.md'), '[2026-11-15] 第一条\n');
  assert.equal((await readdir(join(directory, 'history'))).filter(name => name.startsWith('chatgpt-')).length, 0);
});

test('only the newest backups are kept, and an edit and a bot write never interleave', async t => {
  const { directory, files, read } = await workspace(t);
  let tick = 0;
  const memory = createMemory({ ...files, now: () => new Date(Date.UTC(2026, 10, 15, 0, 0, tick++)) });
  for (let index = 0; index < HISTORY_KEEP + 5; index++) {
    const current = await memory.read('claude');
    await memory.save('claude', `第 ${index} 版\n`, current.version);
  }
  const kept = (await readdir(join(directory, 'history'))).sort();
  assert.equal(kept.length, HISTORY_KEEP);
  assert.equal(await readFile(join(directory, 'history', kept.at(-1)!), 'utf8'), `第 ${HISTORY_KEEP + 3} 版\n`);

  // Started together: the save goes first in the lock, then the append lands on top of it.
  const current = await memory.read('claude');
  await Promise.all([
    memory.save('claude', '手动改的\n', current.version),
    memory.apply({ bot: 'claude', targets: ['claude'], requests: [{ target: 'self', op: 'append', content: 'bot 写的' }] }),
  ]);
  assert.match((await read('claude.md'))!, /^手动改的\n\[\d{4}-\d\d-\d\d\] bot 写的\n$/);
});

test('page: a file that changes while you edit never overwrites your text', () => {
  const file = (content: string, version: string) => ({ name: 'common', content, version, tokens: 0, limit: 8000 });
  const opened = memoryArrived(undefined, file('旧\n', 'v1'));
  assert.deepEqual(opened, { saved: file('旧\n', 'v1'), text: '旧\n' });
  // Not edited: a newer version simply replaces it.
  assert.deepEqual(memoryArrived(opened, file('新\n', 'v2')), { saved: file('新\n', 'v2'), text: '新\n' });
  // Edited: the text stays, and the newer version is held aside.
  const edited = { ...opened, text: '我改的\n' };
  assert(isDirty(edited));
  assert.deepEqual(memoryArrived(edited, file('旧\n', 'v1')), edited);
  const behind = memoryArrived(edited, file('新\n', 'v2'));
  assert.deepEqual([behind.text, behind.saved.version, behind.latest?.version], ['我改的\n', 'v1', 'v2']);
  // "载入最新内容" gives up the edit for what is on disk now.
  assert.deepEqual(loadLatest(behind), { saved: file('新\n', 'v2'), text: '新\n' });
});

test('page: the size shown while typing is estimated the same way as on the backend', () => {
  for (const text of ['', 'hello world', '用户喝咖啡不加糖。', '[2026-11-15] mixed 中英 text 😀\n'.repeat(5)]) assert.equal(estimateTokens(text), backendEstimate(text));
});
