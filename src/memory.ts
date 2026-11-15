import { readFile } from 'node:fs/promises';
import { replaceFile } from './files.ts';
import { designatedWriter } from './routing.ts';
import { estimateTokens } from './tokens.ts';

// Long-term memory writes. Bots only propose; this is the one place that
// checks a request and touches the memory files.

export type MemoryRequest = { target: 'common' | 'self'; op: 'append'; content: string };
/** Returns one notice per request, to be shown in the group. Never throws for a bad request. */
export type ApplyMemory = (input: { bot: string; targets: readonly string[]; requests: readonly MemoryRequest[] }) => Promise<string[]>;

export const DEFAULT_MAX_MEMORY_TOKENS = 8_000;

export type MemoryFiles = {
  commonPath: string;
  selfPath: (bot: string) => string;
  defaultWriter: string;
  /** Above this size a notice asks the user to tidy the file. Nothing is refused or trimmed. */
  maxMemoryTokens?: number;
  now?: () => Date;
};

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function createMemoryWriter(files: MemoryFiles): ApplyMemory {
  const limit = files.maxMemoryTokens ?? DEFAULT_MAX_MEMORY_TOKENS;
  // Memory files are shared by every group, and groups run in parallel. One
  // chain for all writes keeps two appends from reading the same old content.
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };

  // First version only appends. Each entry is dated; within one file a later
  // entry wins over an earlier conflicting one, so order must be preserved.
  const append = (path: string, content: string) => locked(async () => {
    let existing = '';
    try { existing = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing && !existing.endsWith('\n')) existing += '\n';
    const updated = `${existing}[${localDate((files.now ?? (() => new Date()))())}] ${content}\n`;
    // Temp file then rename: a crash mid-write must not leave half a memory file.
    await replaceFile(path, updated);
    return estimateTokens(updated);
  });

  return async ({ bot, targets, requests }) => {
    const writer = designatedWriter(targets, files.defaultWriter);
    const notices: string[] = [];
    for (const request of requests) {
      const common = request.target === 'common';
      const name = common ? '公共记忆' : '自己的记忆';
      const content = request.content.trim();
      if (request.op !== 'append') { notices.push(`已拒绝 ${bot} 写入${name}：第一版只接受追加`); continue; }
      if (!content) { notices.push(`已拒绝 ${bot} 写入${name}：内容为空`); continue; }
      // A bot can only ever name its own private file ("self"), so the one
      // check that matters is who may write the shared file this round.
      if (common && bot !== writer) { notices.push(`已拒绝 ${bot} 写入公共记忆：本轮的写入者是 ${writer}`); continue; }
      try {
        const size = await append(common ? files.commonPath : files.selfPath(bot), content);
        notices.push(`${bot} 写入了${name}：${content}`);
        if (size > limit) notices.push(`${common ? '公共记忆' : `${bot} 的记忆`}已有约 ${size} token，超过 ${limit}，建议整理这个文件`);
      } catch (error) {
        notices.push(`${bot} 写入${name}失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return notices;
  };
}
