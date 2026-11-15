import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type PendingMessage = { id: string; content: string; targets: string[] };
export type ChatMessage = { seq: number; id: string; from: string; type: 'user' | 'reply' | 'failure'; content: string; replyTo?: number };
export type Bot = (input: { message: PendingMessage; history: ChatMessage[] }) => Promise<string>;
type ActiveRound = { message: PendingMessage; userSeq: number; outstanding: string[] };
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
  #bots: Record<string, Bot>;
  #queue: PendingMessage[] = [];
  #history: ChatMessage[] = [];
  #seen = new Map<string, PendingMessage>();
  #active: ActiveRound | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | undefined;
  #nextSeq = 1;
  #poisoned = false;
  recoveryNotes: string[] = [];

  private constructor(file: string, bots: Record<string, Bot>) { this.#file = file; this.#bots = bots; }

  static async open(directory: string, bots: Record<string, Bot>): Promise<Scheduler> {
    await mkdir(directory, { recursive: true });
    const scheduler = new Scheduler(join(directory, 'events.jsonl'), bots);
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
    return scheduler;
  }

  get queue(): PendingMessage[] { return structuredClone(this.#queue); }
  get history(): ChatMessage[] { return structuredClone(this.#history); }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #record(event: Event): Promise<void> {
    if (this.#poisoned) throw new Error('Storage failed; reopen scheduler before continuing');
    const file = await open(this.#file, 'a');
    try {
      await file.writeFile(JSON.stringify(event) + '\n', 'utf8');
      await file.sync();
    } catch (error) { this.#poisoned = true; throw error; }
    finally { await file.close(); }
    this.#apply(event);
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

  enqueue(message: PendingMessage): Promise<boolean> {
    const copy = structuredClone(message);
    return this.#serial(async () => {
      if (!copy.id || !copy.content.trim() || !copy.targets.length || new Set(copy.targets).size !== copy.targets.length || copy.targets.some(bot => typeof this.#bots[bot] !== 'function')) throw new Error('Invalid message or bot targets');
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
    return { seq: this.#nextSeq, id: randomUUID(), from: bot, type, content, replyTo: this.#active!.userSeq };
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
        const message = this.#queue[0];
        if (!message) return undefined;
        await this.#record({ kind: 'start', message, user: { seq: this.#nextSeq, id: message.id, from: 'user', type: 'user', content: message.content } });
        return { message: structuredClone(message), history: structuredClone(this.#history) };
      });
      if (!input) return;
      // Freeze the shared history before invoking any adapter. Each adapter gets
      // its own copy so a mutation cannot contaminate another bot's input.
      const results = await Promise.allSettled(input.message.targets.map(async bot => {
        let type: 'reply' | 'failure' = 'reply';
        let content: string;
        try {
          content = await this.#bots[bot](structuredClone(input));
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
