import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { MessageTooLongError, Scheduler } from '../src/scheduler.ts';
import type { Bot } from '../src/scheduler.ts';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.cwd(), '.scheduler-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const message = (id: string, targets = ['claude']) => ({ id, content: id, targets });

test('queue editing, deletion, promotion and submission dedup survive reopening', async t => {
  const directory = await fixture(t);
  const bots = { claude: async () => 'ok' };
  let scheduler = await Scheduler.open(directory, bots);
  for (const id of ['a', 'b', 'c', 'd']) await scheduler.enqueue(message(id));
  const edited = await scheduler.remove('b');
  assert.equal(edited.content, 'b');
  await scheduler.enqueue({ ...edited, id: 'b-edited', content: 'revised' });
  await scheduler.remove('c');
  await scheduler.moveToTop('d');
  assert.equal(await scheduler.enqueue(message('a')), false);
  await assert.rejects(scheduler.enqueue({ ...message('a'), content: 'different' }), /different payload/);
  assert.deepEqual(scheduler.queue.map(m => m.id), ['d', 'a', 'b-edited']);
  scheduler = await Scheduler.open(directory, bots);
  assert.deepEqual(scheduler.queue.map(m => m.id), ['d', 'a', 'b-edited']);
  await scheduler.runUntilIdle();
  assert.deepEqual(scheduler.history.filter(m => m.type === 'user').map(m => m.id), ['d', 'a', 'b-edited']);
  assert.equal(await scheduler.enqueue(message('c')), false); // Deleted ID cannot silently resurrect.
});

test('bots run in parallel with stable snapshots, while the next round waits', async t => {
  const directory = await fixture(t);
  const gates = { claude: deferred<string>(), codex: deferred<string>() };
  const started = { claude: deferred<void>(), codex: deferred<void>() };
  const seen: Record<string, unknown[]> = { claude: [], codex: [] };
  const bots: Record<string, Bot> = Object.fromEntries(['claude', 'codex'].map(bot => [bot, async input => {
    seen[bot].push(structuredClone(input));
    if (input.message.id === 'first') {
      started[bot as keyof typeof started].resolve();
      input.history[0].content = 'adapter-local mutation';
      return gates[bot as keyof typeof gates].promise;
    }
    return 'second answer';
  }]));
  const scheduler = await Scheduler.open(directory, bots);
  await scheduler.enqueue(message('first', ['claude', 'codex']));
  const run = scheduler.runUntilIdle();
  await Promise.all([started.claude.promise, started.codex.promise]);
  await scheduler.enqueue(message('second', ['claude', 'codex']));
  await assert.rejects(scheduler.remove('first'), /no longer queued/);
  await assert.rejects(scheduler.moveToTop('first'), /no longer queued/);
  assert.deepEqual(seen.claude[0], seen.codex[0]);
  assert.equal(scheduler.history[0].content, 'first');
  assert.equal(seen.claude.length, 1);
  gates.claude.resolve('claude first answer');
  gates.codex.resolve('codex first answer');
  await run;
  for (const bot of ['claude', 'codex']) {
    const next = seen[bot][1] as { history: { content: string }[] };
    assert(next.history.some(m => m.content === 'claude first answer'));
    assert(next.history.some(m => m.content === 'codex first answer'));
  }
  assert.deepEqual(scheduler.history.map(m => m.seq), [1, 2, 3, 4, 5, 6]);
});

test('a bot failure is recorded without preventing its peer or next round', async t => {
  const directory = await fixture(t);
  const scheduler = await Scheduler.open(directory, {
    claude: async () => { throw new Error('simulated timeout after adapter cleanup'); },
    codex: async () => 'peer answer',
  });
  await scheduler.enqueue(message('first', ['claude', 'codex']));
  await scheduler.enqueue(message('next', ['codex']));
  await scheduler.runUntilIdle();
  assert.equal(scheduler.history.filter(m => m.type === 'failure').length, 1);
  assert.equal(scheduler.history.filter(m => m.type === 'reply').length, 2);
  assert.equal(scheduler.history.find(m => m.id === 'next')?.seq, 4);
});

test('concurrent enqueue-and-drain callers do not lose or duplicate messages', async t => {
  const directory = await fixture(t);
  const calls: string[] = [];
  const scheduler = await Scheduler.open(directory, { claude: async input => { calls.push(input.message.id); return 'ok'; } });
  await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    await scheduler.enqueue(message(`message-${index}`));
    await scheduler.runUntilIdle();
  }));
  assert.equal(calls.length, 20);
  assert.equal(new Set(calls).size, 20);
  assert.equal(scheduler.queue.length, 0);
  assert.equal(scheduler.history.filter(m => m.type === 'user').length, 20);
});

test('a storage failure mid-round stops the scheduler instead of skipping the unfinished round', async t => {
  const base = await fixture(t);
  const directory = join(base, 'group'), away = join(base, 'away');
  const gate = deferred<string>(), started = deferred<void>();
  const calls: string[] = [];
  let scheduler = await Scheduler.open(directory, { claude: async input => { calls.push(input.message.id); started.resolve(); return input.message.id === 'm1' ? gate.promise : 'ok'; } });
  await scheduler.enqueue(message('m1'));
  await scheduler.enqueue(message('m2'));
  const run = scheduler.runUntilIdle();
  await started.promise;
  await rename(directory, away); // The journal cannot be opened: saving the answer fails.
  gate.resolve('lost answer');
  await assert.rejects(run);
  assert.equal(scheduler.needsReopen, true);
  await rename(away, directory); // Storage is back, but memory and disk may disagree.
  await assert.rejects(scheduler.runUntilIdle(), /reopen/);
  await assert.rejects(scheduler.enqueue(message('m3')), /reopen/);
  assert.deepEqual(calls, ['m1']); // m2 must not start on top of the unfinished round.
  scheduler = await Scheduler.open(directory, { claude: async input => { calls.push(input.message.id); return 'ok'; } });
  assert.deepEqual(scheduler.history.map(m => [m.seq, m.type]), [[1, 'user'], [2, 'failure']]);
  assert.match(scheduler.history[1].content, /回答中断/);
  assert.deepEqual(scheduler.queue.map(m => m.id), ['m2']);
  await scheduler.runUntilIdle();
  assert.deepEqual(calls, ['m1', 'm2']);
  assert.deepEqual(scheduler.history.map(m => m.seq), [1, 2, 3, 4]);
});

test('an oversized message is refused at enqueue and leaves the group usable', async t => {
  const directory = await fixture(t);
  const calls: string[] = [];
  const scheduler = await Scheduler.open(directory, { claude: async input => { calls.push(input.message.id); return 'ok'; } }, { maxMessageTokens: 100 });
  await assert.rejects(scheduler.enqueue({ id: 'big', content: '很长的消息'.repeat(40) }), (error: unknown) => error instanceof MessageTooLongError && /估算 200 token，单条上限 100/.test(error.message));
  assert.deepEqual([scheduler.queue.length, scheduler.history.length], [0, 0]);
  await scheduler.enqueue({ id: 'small', content: '继续' });
  // The refused ID was never accepted, so the shortened text can reuse it.
  await scheduler.enqueue({ id: 'big', content: '缩短后的消息' });
  await scheduler.runUntilIdle();
  assert.deepEqual(calls, ['small', 'big']);
  assert.equal(scheduler.history.filter(m => m.type === 'failure').length, 0);
});

test('messages without explicit targets are routed by their @ mentions', async t => {
  const directory = await fixture(t);
  const calls: string[] = [];
  const bot = (name: string): Bot => async input => { calls.push(`${name}:${input.message.id}`); return 'ok'; };
  const scheduler = await Scheduler.open(directory, { claude: bot('claude'), chatgpt: bot('chatgpt') });
  await scheduler.enqueue({ id: 'everyone', content: '大家怎么看' });
  await scheduler.enqueue({ id: 'one', content: '@chatgpt 你怎么看' });
  assert.deepEqual(scheduler.queue.map(m => m.targets), [['claude', 'chatgpt'], ['chatgpt']]);
  await scheduler.runUntilIdle();
  assert.deepEqual(calls.sort(), ['chatgpt:everyone', 'chatgpt:one', 'claude:everyone']);
});

test('records.jsonl mirrors the chat history, with timestamps, and is rebuilt on open', async t => {
  const directory = await fixture(t);
  const bots = { claude: async () => 'answer', codex: async () => { throw new Error('boom'); } };
  const readRecords = async () => (await readFile(join(directory, 'records.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  let scheduler = await Scheduler.open(directory, bots);
  assert.deepEqual(await readRecords(), []);
  await scheduler.enqueue(message('first', ['claude', 'codex']));
  await scheduler.enqueue(message('removed'));
  await scheduler.remove('removed');
  await scheduler.enqueue(message('second'));
  await scheduler.runUntilIdle();
  assert.deepEqual(await readRecords(), scheduler.history);
  assert.deepEqual(scheduler.history.map(m => m.type).sort(), ['failure', 'reply', 'reply', 'user', 'user']);
  for (const record of scheduler.history) assert.equal(new Date(record.ts).toISOString(), record.ts);
  assert.deepEqual(Object.keys(scheduler.history[1]), ['seq', 'id', 'ts', 'from', 'type', 'replyTo', 'content']);
  // The view is disposable: losing or corrupting it loses nothing.
  await rm(join(directory, 'records.jsonl'));
  scheduler = await Scheduler.open(directory, bots);
  assert.deepEqual(await readRecords(), scheduler.history);
  await appendFile(join(directory, 'records.jsonl'), 'garbage');
  scheduler = await Scheduler.open(directory, bots);
  assert.deepEqual(await readRecords(), scheduler.history);
});

test('real process termination recovers a partially answered round and queued message', { timeout: 15000 }, async t => {
  const directory = await fixture(t);
  const child = spawn(process.execPath, ['tests/fixtures/scheduler-crash.ts', directory], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('CRASH_READY')) resolve(); });
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`Child exited before checkpoint: ${stderr}`)));
  });
  child.kill();
  await closed;
  // Also simulate a partial final disk write left by abrupt termination.
  await appendFile(join(directory, 'events.jsonl'), '{"kind":"enq');
  const calls: string[] = [];
  const scheduler = await Scheduler.open(directory, {
    claude: async input => { calls.push(input.message.id); return 'new answer'; },
    codex: async () => { throw new Error('Interrupted bot must not be retried'); },
  });
  assert.equal(scheduler.history.filter(m => m.content === 'saved answer').length, 1);
  assert.equal(scheduler.history.filter(m => m.type === 'failure' && m.from === 'codex').length, 1);
  assert.deepEqual(scheduler.queue.map(m => m.id), ['waiting']);
  assert.equal(scheduler.recoveryNotes.length, 2);
  await scheduler.runUntilIdle();
  assert.deepEqual(calls, ['waiting']);
  const reopened = await Scheduler.open(directory, { claude: async () => 'unused' });
  assert.deepEqual(reopened.history, scheduler.history);
  assert.deepEqual(reopened.queue, []);
  const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
  assert(raw.endsWith('\n'));
});
