import { rename, writeFile } from 'node:fs/promises';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Replaces a file in one step: write a temp file, then rename it over the
 * target, so a reader or a crash never sees half a file.
 *
 * On Windows the rename fails for a moment when another program (antivirus,
 * the search indexer, a reader) has the target open. That is not a real
 * failure, so it is retried for about a second before giving up.
 */
export async function replaceFile(path: string, content: string): Promise<void> {
  const temp = path + '.tmp';
  await writeFile(temp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { await rename(temp, path); return; }
    catch (error) {
      if (attempt >= 6 || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 15 * 2 ** attempt));
    }
  }
}
