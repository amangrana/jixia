import { readFileSync, unlinkSync } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// One running jixia per data directory. Opening a group already writes to it
// (an interrupted round is closed, the queue resumes, records.jsonl is
// rebuilt), so a second instance must stop before it touches anything, even
// one that would listen on a different port.
//
// The lock is a file created with O_EXCL holding the owner's PID. A lock whose
// PID no longer runs is left over from a crash and is taken over. Windows
// reuses PIDs, so a stale lock can occasionally look alive; the refusal says
// which file to delete in that case.

export class DataLockedError extends Error {
  readonly path: string;
  readonly owner: LockOwner;
  constructor(path: string, owner: LockOwner) {
    super(`另一个稷下（PID ${owner.pid}${owner.port ? `，端口 ${owner.port}` : ''}）正在使用这个数据目录。两个实例同时运行会写坏聊天记录，所以没有启动。确认没有别的稷下在运行的话，删掉 ${path} 再启动`);
    this.name = 'DataLockedError';
    this.path = path;
    this.owner = owner;
  }
}

export type LockOwner = { pid: number; port?: number; startedAt?: string };
export type DataLock = { path: string; release: () => void };

/** True when a process with this PID exists. EPERM means it exists but belongs to someone else. */
export function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const readOwner = async (path: string): Promise<LockOwner | undefined> => {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as LockOwner;
    return typeof owner?.pid === 'number' ? owner : { pid: 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { pid: 0 }; // Unreadable or half-written: treated as left over from a crash.
  }
};

/**
 * Takes the lock on `dataDir` for this process, or throws DataLockedError.
 * Call before anything reads or writes the data directory.
 */
export async function acquireDataLock(dataDir: string, info: { port?: number } = {}, alive: (pid: number) => boolean = isRunning): Promise<DataLock> {
  const path = join(dataDir, 'jixia.lock');
  const mine: LockOwner = { pid: process.pid, ...(info.port ? { port: info.port } : {}), startedAt: new Date().toISOString() };
  // Two tries: the second only after removing a lock left by a dead process.
  // If another instance takes it in between, its create wins and ours fails.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx');
      try { await file.writeFile(JSON.stringify(mine), 'utf8'); } finally { await file.close(); }
      return { path, release: () => releaseIfMine(path) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readOwner(path);
      if (owner && owner.pid !== process.pid && alive(owner.pid)) throw new DataLockedError(path, owner);
      if (owner?.pid === process.pid) throw new DataLockedError(path, owner); // Taken twice in one process: a bug, not a crash.
      await unlink(path).catch(() => {});
    }
  }
  throw new DataLockedError(path, (await readOwner(path)) ?? { pid: 0 });
}

// Synchronous so it can run in an 'exit' handler. Only removes our own lock:
// after a takeover the file may belong to another instance.
function releaseIfMine(path: string): void {
  try {
    if ((JSON.parse(readFileSync(path, 'utf8')) as LockOwner).pid === process.pid) unlinkSync(path);
  } catch { /* already gone */ }
}
