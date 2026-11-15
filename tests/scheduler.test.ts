import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Scheduler } from '../src/scheduler.ts';
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
