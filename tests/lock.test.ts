import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataLock, DataLockedError, isRunning } from '../src/lock.ts';

const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const directory = await mkdtemp(join(tmpdir(), 'jixia-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
// A PID that certainly belonged to a process that has ended.
const finishedPid = () => spawnSync(process.execPath, ['-e', '0']).pid!;

test('one lock per data directory: a second taker is refused and told who holds it', async t => {
  const directory = await temp(t);
  const lock = await acquireDataLock(directory, { port: 4517 });
  assert.deepEqual(JSON.parse(await readFile(lock.path, 'utf8')).pid, process.pid);
  // Another live process holds it (here: pretend every PID is alive, and the file names another one).
  await writeFile(lock.path, JSON.stringify({ pid: process.pid + 1, port: 4600 }));
  await assert.rejects(acquireDataLock(directory, {}, () => true), (error: unknown) => {
    assert(error instanceof DataLockedError);
    assert.match(error.message, /PID \d+，端口 4600/);
    assert.match(error.message, /jixia\.lock/);
    return true;
  });
});

test('a lock left by a process that has ended is taken over; release removes only our own lock', async t => {
  const directory = await temp(t);
  const dead = finishedPid();
  assert.equal(isRunning(dead), false);
  assert.equal(isRunning(process.pid), true);
  await writeFile(join(directory, 'jixia.lock'), JSON.stringify({ pid: dead, port: 4517 }));
  const lock = await acquireDataLock(directory);
  assert.equal(JSON.parse(await readFile(lock.path, 'utf8')).pid, process.pid);
  // A half-written lock file counts as left over too.
  lock.release();
  await writeFile(lock.path, '{"pi');
  const again = await acquireDataLock(directory);
  // Someone else took over after us: our release must not remove their lock.
  await writeFile(again.path, JSON.stringify({ pid: process.pid + 1 }));
  again.release();
  assert.equal(JSON.parse(await readFile(again.path, 'utf8')).pid, process.pid + 1);
});

test('taking the same lock twice in one process is refused rather than silently shared', async t => {
  const directory = await temp(t);
  await acquireDataLock(directory);
  await assert.rejects(acquireDataLock(directory), DataLockedError);
});
