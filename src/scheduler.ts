import { appendFile, mkdir, open, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveTargets } from './routing.ts';
import { estimateTokens } from './tokens.ts';

export const DEFAULT_MAX_MESSAGE_TOKENS = 30_000;
/** Thrown by enqueue; the message was not queued, so the UI keeps the text in the input box. */
export class MessageTooLongError extends Error {
  constructor(tokens: number, limit: number) { super(`消息过长，没有发送：估算 ${tokens} token，单条上限 ${limit}。请缩短或拆分后重发`); this.name = 'MessageTooLongError'; }
}

export type PendingMessage = { id: string; content: string; targets: string[] };
// Omit targets to route by the @ mentions in the content.
export type NewMessage = { id: string; content: string; targets?: string[] };
// Key order matches the record example in the design doc; records.jsonl prints it as-is.
export type ChatMessage = { seq: number; id: string; ts: string; from: string; type: 'user' | 'reply' | 'failure'; replyTo?: number; content: string };
export type RoundInput = { message: PendingMessage; history: ChatMessage[] };
export type Bot = (input: RoundInput & { prompt?: string }) => Promise<string>;
// Runs once per round before any bot starts and returns each target bot's
// prompt, or the reason that bot must not be called this round.
export type Prepare = (input: RoundInput) => Promise<Record<string, { prompt: string } | { error: string }>>;
export type SchedulerOptions = { prepare?: Prepare; maxMessageTokens?: number };
type ActiveRound ={ message: PendingMessage; userSeq: number; outstanding: string[] };
type Event =
  | { kind: 'enqueue'; message: PendingMessage }
  | { kind: 'remove' | 'top'; id: string }
  | { kind: 'start'; message: PendingMessage; user: ChatMessage }
  | { kind: 'result'; bot: string; message: ChatMessage }
  | { kind: 'finish' };

// One instance per group. The journal is authoritative: dequeue + chat insertion
// are represented by one event, avoiding a queue.json/JSONL two-file transaction.
export class Scheduler {
  #file: string;
  // Chat-only view derived from the journal, for people and bots to read.
  // Never read back as state: it is rebuilt from the journal on every open.
  #records: string;
  #projecting = false;
  #recordsStale = false;
  #bots: Record<string, Bot>;
  #prepare: Prepare | undefined;
  #maxMessageTokens: number;
  #queue: PendingMessage[] = [];
  #history: ChatMessage[] = [];
  #seen = new Map<string, PendingMessage>();
  #active: ActiveRound | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | undefined;
  #nextSeq = 1;
  #poisoned = false;
  recoveryNotes: string[] = [];

  private constructor(directory: string, bots: Record<string, Bot>, options: SchedulerOptions) {
    this.#file = join(directory, 'events.jsonl');
    this.#records = join(directory, 'records.jsonl');
    this.#bots = bots;
    this.#prepare = options.prepare;
    this.#maxMessageTokens = options.maxMessageTokens ?? DEFAULT_MAX_MESSAGE_TOKENS;
  }

  static async open(directory: string, bots: Record<string, Bot>, options: SchedulerOptions = {}): Promise<Scheduler> {
    await mkdir(directory, { recursive: true });
    const scheduler = new Scheduler(directory, bots, options);
    let raw: Buffer;
    try { raw = await readFile(scheduler.#file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; raw = Buffer.alloc(0); }
    let offset = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(10, offset);
      // Only newline-terminated events are committed. Repair an incomplete tail
      // before appending, rather than concatenating new events onto broken JSON.
      if (end === -1) {
        await truncate(scheduler.#file, offset);
        scheduler.recoveryNotes.push('Discarded incomplete journal tail');
        break;
      }
      const line = raw.subarray(offset, end).toString('utf8');
      scheduler.#apply(JSON.parse(line) as Event); // Interior corruption fails closed.
      offset = end + 1;
    }
    if (scheduler.#active) {
      for (const bot of [...scheduler.#active.outstanding]) {
        await scheduler.#record({ kind: 'result', bot, message: scheduler.#result(bot, 'failure', '回答中断：应用已重启') });
      }
      await scheduler.#record({ kind: 'finish' });
      scheduler.recoveryNotes.push('Interrupted round closed without retry');
    }
    scheduler.#projecting = true;
    try { await scheduler.#rebuildRecords(); }
    catch { scheduler.#recordsStale = true; scheduler.recoveryNotes.push('Could not write records.jsonl; will retry'); }
    return scheduler;
  }

  async #rebuildRecords(): Promise<void> {
    const temp = this.#records + '.tmp';
    await writeFile(temp, this.#history.map(message => JSON.stringify(message) + '\n').join(''), 'utf8');
    await rename(temp, this.#records);
    this.#recordsStale = false;
  }

  // A failure here must not fail the round: the journal already holds the
  // message, so mark the view stale and rebuild it on the next message.
  async #project(message: ChatMessage): Promise<void> {
    if (!this.#projecting) return;
    try {
      if (this.#recordsStale) await this.#rebuildRecords();
      else await appendFile(this.#records, JSON.stringify(message) + '\n', 'utf8');
    } catch { this.#recordsStale = true; }
  }

  /** True after a storage failure: every further call fails until the group is opened again. */
  get needsReopen(): boolean { return this.#poisoned; }
  get queue(): PendingMessage[] { return structuredClone(this.#queue); }
  get history(): ChatMessage[] { return structuredClone(this.#history); }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #record(event: Event): Promise<void> {
    if (this.#poisoned) throw new Error('Storage failed; reopen scheduler before continuing');
    // Any failure, including open and close, leaves it unknown whether the
    // event reached the disk. Memory may then be ahead of or behind the journal,
    // so stop here; reopening replays what is actually on disk.
    try {
      const file = await open(this.#file, 'a');
      try {
        await file.writeFile(JSON.stringify(event) + '\n', 'utf8');
        await file.sync();
      } finally { await file.close(); }
    } catch (error) { this.#poisoned = true; throw error; }
    this.#apply(event);
    if (event.kind === 'start') await this.#project(event.user);
    else if (event.kind === 'result') await this.#project(event.message);
  }

  #apply(event: Event): void {
    if (event.kind === 'enqueue') { this.#queue.push(event.message); this.#seen.set(event.message.id, event.message); }
    else if (event.kind === 'remove') this.#queue = this.#queue.filter(m => m.id !== event.id);
    else if (event.kind === 'top') {
      const message = this.#queue.find(m => m.id === event.id);
      if (!message) throw new Error('Invalid top event');
      this.#queue = [message, ...this.#queue.filter(m => m.id !== event.id)];
    } else if (event.kind === 'start') {
      this.#queue = this.#queue.filter(m => m.id !== event.message.id);
      this.#history.push(event.user);
      this.#nextSeq = event.user.seq + 1;
      this.#active = { message: event.message, userSeq: event.user.seq, outstanding: [...event.message.targets] };
    } else if (event.kind === 'result') {
      if (!this.#active?.outstanding.includes(event.bot)) throw new Error('Invalid result event');
      this.#history.push(event.message);
      this.#nextSeq = event.message.seq + 1;
      this.#active.outstanding = this.#active.outstanding.filter(bot => bot !== event.bot);
    } else if (event.kind === 'finish') {
      if (!this.#active || this.#active.outstanding.length) throw new Error('Cannot finish incomplete round');
      this.#active = undefined;
    }
  }

  enqueue(message: NewMessage): Promise<boolean> {
    const copy: PendingMessage = {
      id: message.id,
      content: message.content,
      targets: message.targets ? [...message.targets] : resolveTargets(message.content, Object.keys(this.#bots)),
    };
    return this.#serial(async () => {
      if (!copy.id || !copy.content.trim() || !copy.targets.length || new Set(copy.targets).size !== copy.targets.length || copy.targets.some(bot => typeof this.#bots[bot] !== 'function')) throw new Error('Invalid message or bot targets');
      // A message enters every later prompt once it is in the history, so one
      // oversized message would get every following round refused. Stop it here.
      const tokens = estimateTokens(copy.content);
      if (tokens > this.#maxMessageTokens) throw new MessageTooLongError(tokens, this.#maxMessageTokens);
      const previous = this.#seen.get(copy.id);
      if (previous) {
        if (previous.content !== copy.content || previous.targets.join('\0') !== copy.targets.join('\0')) throw new Error('Message ID reused with different payload');
        return false;
      }
      await this.#record({ kind: 'enqueue', message: copy });
      return true;
    });
  }

  remove(id: string): Promise<PendingMessage> {
    return this.#serial(async () => {
      const message = this.#queue.find(m => m.id === id);
      if (!message) throw new Error('Message is no longer queued');
      await this.#record({ kind: 'remove', id });
      return structuredClone(message); // UI can restore this exact accepted text.
    });
  }

  moveToTop(id: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.#queue.some(m => m.id === id)) throw new Error('Message is no longer queued');
      if (this.#queue[0].id !== id) await this.#record({ kind: 'top', id });
    });
  }

  #result(bot: string, type: 'reply' | 'failure', content: string): ChatMessage {
    return { seq: this.#nextSeq, id: randomUUID(), ts: new Date().toISOString(), from: bot, type, replyTo: this.#active!.userSeq, content };
  }

  // The caller triggers draining after enqueue. Recheck after an existing run
  // completes so an enqueue at its idle boundary cannot lose a wake-up.
  runUntilIdle(): Promise<void> {
    if (this.#running) return this.#running.then(() => this.runUntilIdle());
    this.#running = this.#drain().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #drain(): Promise<void> {
    while (true) {
      const input = await this.#serial(async () => {
        if (this.#poisoned) throw new Error('Storage failed; reopen scheduler before continuing');
        // Starting a round would overwrite the unfinished one and drop its missing answers.
        if (this.#active) throw new Error('Previous round is unfinished; reopen scheduler before continuing');
        const message = this.#queue[0];
        if (!message) return undefined;
        await this.#record({ kind: 'start', message, user: { seq: this.#nextSeq, id: message.id, ts: new Date().toISOString(), from: 'user', type: 'user', content: message.content } });
        return { message: structuredClone(message), history: structuredClone(this.#history) };
      });
      if (!input) return;
      // Freeze the shared history before invoking any adapter. Each adapter gets
      // its own copy so a mutation cannot contaminate another bot's input.
      // All prompts are built before any bot starts, so bots in one round read
      // the same history and memory even if a file changes mid-round.
      let prepared: Awaited<ReturnType<Prepare>> | undefined;
      let prepareError: string | undefined;
      if (this.#prepare) {
        try { prepared = await this.#prepare(structuredClone(input)); }
        catch (error) { prepareError = error instanceof Error ? error.message : String(error); }
      }
      const results = await Promise.allSettled(input.message.targets.map(async bot => {
        let type: 'reply' | 'failure' = 'reply';
        let content: string;
        try {
          if (prepareError !== undefined) throw new Error(prepareError);
          const entry = prepared?.[bot];
          if (this.#prepare && !entry) throw new Error('没有为该 bot 准备上下文');
          if (entry && 'error' in entry) throw new Error(entry.error);
          content = await this.#bots[bot]({ ...structuredClone(input), ...(entry ? { prompt: entry.prompt } : {}) });
          if (typeof content !== 'string') throw new Error('Bot returned non-text output');
        } catch (error) { type = 'failure'; content = error instanceof Error ? error.message : String(error); }
        await this.#serial(() => this.#record({ kind: 'result', bot, message: this.#result(bot, type, content) }));
      }));
      const failedWrite = results.find(result => result.status === 'rejected');
      if (failedWrite?.status === 'rejected') throw failedWrite.reason;
      await this.#serial(() => this.#record({ kind: 'finish' }));
    }
  }
}
