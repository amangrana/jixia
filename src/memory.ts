import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { designatedWriter } from './routing.ts';
import { replaceFile } from './files.ts';
import { estimateTokens } from './tokens.ts';

// Long-term memory. Bots only propose writes; you can also edit the files in
// the app. This is the one place that touches the memory files, and both
// kinds of change go through the same lock.

export type MemoryRequest = { target: 'common' | 'self'; op: 'append'; content: string };
/** Returns one notice per request, to be shown in the group. Never throws for a bad request. */
export type ApplyMemory = (input: { bot: string; targets: readonly string[]; requests: readonly MemoryRequest[] }) => Promise<string[]>;

export const DEFAULT_MAX_MEMORY_TOKENS = 8_000;
export const HISTORY_KEEP = 20;

export type MemoryFiles = {
  commonPath: string;
  selfPath: (bot: string) => string;
  defaultWriter: string;
  /** Above this size a notice asks the user to tidy the file. Nothing is refused or trimmed. */
  maxMemoryTokens?: number;
  /** Bots that have a memory file, in display order. Needed only for reading and editing. */
  bots?: readonly string[];
  /** Where copies are kept before an edit replaces a file. Defaults to `history` next to the common file. */
  historyDir?: string;
  now?: () => Date;
};

/** One memory file as the page shows it. `name` is "common" or a bot name. */
export type MemoryFile = { name: string; content: string; version: string; tokens: number; limit: number };

/** The file changed after the editor opened it; nothing was written. */
export class MemoryChangedError extends Error {
  latest: MemoryFile;
  constructor(latest: MemoryFile) { super('记忆在你打开之后被改过（可能是 bot 写入了新内容），没有保存'); this.name = 'MemoryChangedError'; this.latest = latest; }
}

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');
/** A file that does not exist yet reads as empty; its version is that of empty text. */
const versionOf = (content: string) => createHash('sha256').update(content).digest('hex').slice(0, 16);

export function createMemory(files: MemoryFiles) {
  const limit = files.maxMemoryTokens ?? DEFAULT_MAX_MEMORY_TOKENS;
  const now = () => (files.now ?? (() => new Date()))();
  const historyDir = files.historyDir ?? join(dirname(files.commonPath), 'history');
  const listeners = new Set<(name: string) => void>();
  const changed = (name: string) => { for (const listener of listeners) try { listener(name); } catch { /* listener's problem */ } };
  // Memory files are shared by every group, and groups run in parallel. One
  // chain for all writes keeps two writers from reading the same old content.
  let tail: Promise<unknown> = Promise.resolve();
  const locked = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  };

  const names = () => ['common', ...(files.bots ?? [])];
  const pathOf = (name: string) => {
    if (name === 'common') return files.commonPath;
    if (!(files.bots ?? []).includes(name)) throw new RangeError(`没有名为 ${name} 的记忆`);
    return files.selfPath(name);
  };
  const readText = async (path: string) => {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
  };
  const describe = (name: string, content: string): MemoryFile => ({ name, content, version: versionOf(content), tokens: estimateTokens(content), limit });

  // First version only appends. Each entry is dated; within one file a later
  // entry wins over an earlier conflicting one, so order must be preserved.
  // A bot names only "common" or itself, so this path needs no list of bots;
  // that list guards only the names the memory page may ask for.
  const append = (name: string, content: string) => locked(async () => {
    const path = name === 'common' ? files.commonPath : files.selfPath(name);
    let existing = await readText(path);
    if (existing && !existing.endsWith('\n')) existing += '\n';
    const updated = `${existing}[${localDate(now())}] ${content}\n`;
    // Temp file then rename: a crash mid-write must not leave half a memory file.
    await replaceFile(path, updated);
    changed(name);
    return estimateTokens(updated);
  });

  // Keeps the newest HISTORY_KEEP copies of one file. Names sort by time.
  const prune = async (name: string) => {
    const copies = (await readdir(historyDir)).filter(file => file.startsWith(`${name}-`) && file.endsWith('.md')).sort();
    for (const old of copies.slice(0, Math.max(0, copies.length - HISTORY_KEEP))) await rm(join(historyDir, old), { force: true });
  };

  const apply: ApplyMemory = async ({ bot, targets, requests }) => {
    const writer = designatedWriter(targets, files.defaultWriter);
    const notices: string[] = [];
    for (const request of requests) {
      const common = request.target === 'common';
      const label = common ? '公共记忆' : '自己的记忆';
      const content = request.content.trim();
      if (request.op !== 'append') { notices.push(`已拒绝 ${bot} 写入${label}：第一版只接受追加`); continue; }
      if (!content) { notices.push(`已拒绝 ${bot} 写入${label}：内容为空`); continue; }
      // A bot can only ever name its own private file ("self"), so the one
      // check that matters is who may write the shared file this round.
      if (common && bot !== writer) { notices.push(`已拒绝 ${bot} 写入公共记忆：本轮的写入者是 ${writer}`); continue; }
      try {
        const size = await append(common ? 'common' : bot, content);
        notices.push(`${bot} 写入了${label}：${content}`);
        if (size > limit) notices.push(`${common ? '公共记忆' : `${bot} 的记忆`}已有约 ${size} token，超过 ${limit}，建议整理这个文件`);
      } catch (error) {
        notices.push(`${bot} 写入${label}失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return notices;
  };

  return {
    apply,
    /** Every memory file, common first. */
    list: () => Promise.all(names().map(async name => describe(name, await readText(pathOf(name))))),
    read: async (name: string) => describe(name, await readText(pathOf(name))),
    /**
     * Replaces a file with what you wrote, if it is still the version you
     * opened (`baseVersion`). Otherwise throws MemoryChangedError with the
     * current content and writes nothing. The old content is copied to the
     * history folder first.
     */
    save: (name: string, content: string, baseVersion: string) => locked(async () => {
      const path = pathOf(name);
      const current = await readText(path);
      if (versionOf(current) !== baseVersion) throw new MemoryChangedError(describe(name, current));
      if (current === content) return describe(name, current);
      if (current) {
        await mkdir(historyDir, { recursive: true });
        await writeFile(join(historyDir, `${name}-${stamp(now())}.md`), current, 'utf8');
        await prune(name);
      }
      await mkdir(dirname(path), { recursive: true });
      await replaceFile(path, content);
      changed(name);
      return describe(name, content);
    }),
    /** Called with the file's name after every write, by a bot or by you. */
    subscribe(listener: (name: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type Memory = ReturnType<typeof createMemory>;

/** Just the bots' side, for callers that only apply write requests. */
export function createMemoryWriter(files: MemoryFiles): ApplyMemory {
  return createMemory(files).apply;
}
