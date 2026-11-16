import { appendFile, mkdir, open, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveTargets } from './routing.ts';
import { estimateTokens } from './tokens.ts';
import type { ApplyMemory, MemoryRequest } from './memory.ts';

export const DEFAULT_MAX_MESSAGE_TOKENS = 30_000;
/** Thrown by enqueue; the message was not queued, so the UI keeps the text in the input box. */
export class MessageTooLongError extends Error {
  constructor(tokens: number, limit: number) { super(`消息过长，没有发送：估算 ${tokens} token，单条上限 ${limit}。请缩短或拆分后重发`); this.name = 'MessageTooLongError'; }
}

// `discuss` asks for an automatic discussion after the first answers: how many
// more steps at most (1 to MAX_DISCUSSION_ROUNDS). Absent means a plain round.
export type PendingMessage = { id: string; content: string; targets: string[]; discuss?: number };
// Omit targets to route by the @ mentions in the content.
export type NewMessage = { id: string; content: string; targets?: string[]; discuss?: number };
export const MAX_DISCUSSION_ROUNDS = 4;
/** Which step of a discussion a call or an answer belongs to. `rounds` counts the first answers too. */
export type DiscussionStep = { round: number | 'summary'; rounds: number };
// Key order matches the record example in the design doc; records.jsonl prints it as-is.
// A 'notice' is the app speaking in the group (from "system"), e.g. the outcome of a memory write.
// `model` and `effort` are on answers only, and only when the bot reported them.
// `discussion` marks an answer given in a discussion: its step, or 'summary'.
export type ChatMessage = { seq: number; id: string; ts: string; from: string; type: 'user' | 'reply' | 'failure' | 'notice'; replyTo?: number; content: string; model?: string; effort?: string; discussion?: number | 'summary' };
// `step` is set during a discussion; the prompt then carries the discussion instructions.
export type RoundInput = { message: PendingMessage; history: ChatMessage[]; step?: DiscussionStep };
// `moreToSay` matters only in discussion steps; a bot that does not say counts as having more.
export type BotReply = { reply: string; memoryRequests?: MemoryRequest[]; model?: string; effort?: string; moreToSay?: boolean };
// `model` and `effort` are what the group asks this bot to use; absent means the bot's own default.
// `webSearch` and `keepSessions` are the group's switches; absent means off.
export type Bot = (input: RoundInput & { prompt?: string; stable?: string; model?: string; effort?: string; webSearch?: boolean; keepSessions?: boolean }) => Promise<string | BotReply>;
// Runs once per round before any bot starts and returns each target bot's
// prompt, or the reason that bot must not be called this round.
// `stable`, when given, is the leading part of `prompt` that rarely changes between rounds.
export type Prepare = (input: RoundInput) => Promise<Record<string, { prompt: string; stable?: string } | { error: string }>>;
export type RoundState = { messageId: string; userSeq: number; pending: string[]; step?: DiscussionStep };
// What a UI needs to stay current. Emitted only after the change is on disk.
export type SchedulerEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'queue'; queue: PendingMessage[] }
  | { type: 'round'; round: RoundState | null };
export type DiscussionOptions = {
  /** Writes the summary when it took part; otherwise the first bot that answered does. */
  defaultWriter: string;
  /** Asked before each new step and before the summary; a reason means stop (e.g. a usage limit nearly reached). */
  canContinue?: (bots: string[]) => string | undefined;
};
export type SchedulerOptions = { prepare?: Prepare; maxMessageTokens?: number; applyMemory?: ApplyMemory; onEvent?: (event: SchedulerEvent) => void; discussion?: DiscussionOptions };
/** The group was deleted; nothing more can be done in it. */
export class GroupRetiredError extends Error {
  constructor() { super('这个群已删除'); this.name = 'GroupRetiredError'; }
}
/** The message already started processing (or was removed), so it can no longer be edited, deleted or moved. */
export class NotQueuedError extends Error {
  constructor() { super('Message is no longer queued'); this.name = 'NotQueuedError'; }
}
type ActiveRound = { message: PendingMessage; userSeq: number; outstanding: string[]; step?: DiscussionStep };
type Event =
  | { kind: 'enqueue'; message: PendingMessage }
  | { kind: 'remove' | 'top'; id: string }
  | { kind: 'start'; message: PendingMessage; user: ChatMessage }
  | { kind: 'result'; bot: string; message: ChatMessage }
  | { kind: 'notice'; message: ChatMessage }
  // A discussion goes on to its next step (or the summary) with these bots.
  | { kind: 'step'; step: DiscussionStep; bots: string[] }
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
  #applyMemory: ApplyMemory | undefined;
  #discussion: DiscussionOptions | undefined;
  // Set by stopDiscussion() for the round in progress. Not journaled: a restart ends the round anyway.
  #stopRequested = false;
  #onEvent: ((event: SchedulerEvent) => void) | undefined;
  #queue: PendingMessage[] = [];
  #history: ChatMessage[] = [];
  #seen = new Map<string, PendingMessage>();
  #active: ActiveRound | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | undefined;
  #nextSeq = 1;
  #poisoned = false;
  // Set by retire(): the group is being deleted, so nothing more is written.
  #retired = false;
  recoveryNotes: string[] = [];

  private constructor(directory: string, bots: Record<string, Bot>, options: SchedulerOptions) {
    this.#file = join(directory, 'events.jsonl');
    this.#records = join(directory, 'records.jsonl');
    this.#bots = bots;
    this.#prepare = options.prepare;
    this.#maxMessageTokens = options.maxMessageTokens ?? DEFAULT_MAX_MESSAGE_TOKENS;
    this.#applyMemory = options.applyMemory;
    this.#discussion = options.discussion;
    this.#onEvent = options.onEvent;
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
  get round(): RoundState | null {
    if (!this.#active) return null;
    return { messageId: this.#active.message.id, userSeq: this.#active.userSeq, pending: [...this.#active.outstanding], ...(this.#active.step ? { step: { ...this.#active.step } } : {}) };
  }

  // A listener that throws must not disturb scheduling.
  #emit(event: Event): void {
    if (!this.#onEvent) return;
    const send = (payload: SchedulerEvent) => { try { this.#onEvent!(structuredClone(payload)); } catch { /* listener's problem */ } };
    if (event.kind === 'enqueue' || event.kind === 'remove' || event.kind === 'top' || event.kind === 'start') send({ type: 'queue', queue: this.#queue });
    if (event.kind === 'start') send({ type: 'message', message: event.user });
    if (event.kind === 'result' || event.kind === 'notice') send({ type: 'message', message: event.message });
    if (event.kind === 'start' || event.kind === 'result' || event.kind === 'step' || event.kind === 'finish') send({ type: 'round', round: this.round });
  }
  get queue(): PendingMessage[] { return structuredClone(this.#queue); }
  get history(): ChatMessage[] { return structuredClone(this.#history); }

  #serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #record(event: Event): Promise<void> {
    if (this.#retired) throw new GroupRetiredError();
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
    this.#emit(event);
    if (event.kind === 'start') await this.#project(event.user);
    else if (event.kind === 'result' || event.kind === 'notice') await this.#project(event.message);
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
      this.#active = { message: event.message, userSeq: event.user.seq, outstanding: [...event.message.targets], ...(discussing(event.message) ? { step: { round: 1, rounds: event.message.discuss! + 1 } } : {}) };
    } else if (event.kind === 'result') {
      if (!this.#active?.outstanding.includes(event.bot)) throw new Error('Invalid result event');
      this.#history.push(event.message);
      this.#nextSeq = event.message.seq + 1;
      this.#active.outstanding = this.#active.outstanding.filter(bot => bot !== event.bot);
    } else if (event.kind === 'notice') {
      if (!this.#active) throw new Error('Invalid notice event');
      this.#history.push(event.message);
      this.#nextSeq = event.message.seq + 1;
    } else if (event.kind === 'step') {
      if (!this.#active || this.#active.outstanding.length || !event.bots.length) throw new Error('Invalid step event');
      this.#active.outstanding = [...event.bots];
      this.#active.step = { ...event.step };
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
      ...(message.discuss === undefined ? {} : { discuss: message.discuss }),
    };
    return this.#serial(async () => {
      if (!copy.id || !copy.content.trim() || !copy.targets.length || new Set(copy.targets).size !== copy.targets.length || copy.targets.some(bot => typeof this.#bots[bot] !== 'function')) throw new Error('Invalid message or bot targets');
      if (copy.discuss !== undefined && !(Number.isInteger(copy.discuss) && copy.discuss >= 1 && copy.discuss <= MAX_DISCUSSION_ROUNDS)) throw new RangeError(`讨论回合数只能是 1 到 ${MAX_DISCUSSION_ROUNDS}`);
      // A message enters every later prompt once it is in the history, so one
      // oversized message would get every following round refused. Stop it here.
      const tokens = estimateTokens(copy.content);
      if (tokens > this.#maxMessageTokens) throw new MessageTooLongError(tokens, this.#maxMessageTokens);
      const previous = this.#seen.get(copy.id);
      if (previous) {
        if (previous.content !== copy.content || previous.targets.join('\0') !== copy.targets.join('\0') || previous.discuss !== copy.discuss) throw new Error('Message ID reused with different payload');
        return false;
      }
      await this.#record({ kind: 'enqueue', message: copy });
      return true;
    });
  }

  remove(id: string): Promise<PendingMessage> {
    return this.#serial(async () => {
      const message = this.#queue.find(m => m.id === id);
      if (!message) throw new NotQueuedError();
      await this.#record({ kind: 'remove', id });
      return structuredClone(message); // UI can restore this exact accepted text.
    });
  }

  /**
   * Stops this group for good, for deletion. Runs in the same serial order as
   * starting a round, so it either happens before the next round starts or
   * waits for nothing: it refuses (returns false) while a round is running,
   * because a running round cannot be cancelled. After it returns true, nothing
   * is written and no round starts; queued messages are left as they are.
   */
  retire(): Promise<boolean> {
    return this.#serial(async () => {
      if (this.#active) return false;
      this.#retired = true;
      return true;
    });
  }

  /**
   * Asks the discussion in progress to stop: the step that is running finishes,
   * no new step starts, and the summary is written. False when no discussion
   * is running or it is already at its summary.
   */
  stopDiscussion(): boolean {
    const step = this.#active?.step;
    if (!step || step.round === 'summary' || this.#stopRequested) return false;
    this.#stopRequested = true;
    return true;
  }

  moveToTop(id: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.#queue.some(m => m.id === id)) throw new NotQueuedError();
      if (this.#queue[0].id !== id) await this.#record({ kind: 'top', id });
    });
  }

  #result(bot: string, type: 'reply' | 'failure' | 'notice', content: string): ChatMessage {
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
      const message = await this.#serial(async () => {
        if (this.#retired) return undefined;
        if (this.#poisoned) throw new Error('Storage failed; reopen scheduler before continuing');
        // Starting a round would overwrite the unfinished one and drop its missing answers.
        if (this.#active) throw new Error('Previous round is unfinished; reopen scheduler before continuing');
        const next = this.#queue[0];
        if (!next) return undefined;
        this.#stopRequested = false;
        await this.#record({ kind: 'start', message: next, user: { seq: this.#nextSeq, id: next.id, ts: new Date().toISOString(), from: 'user', type: 'user', content: next.content } });
        return structuredClone(next);
      });
      if (!message) return;
      const first = await this.#runStep(message, message.targets, this.#active?.step);
      if (message.discuss !== undefined) await this.#discuss(message, first);
      await this.#serial(() => this.#record({ kind: 'finish' }));
    }
  }

  /**
   * Calls these bots once, all with the same frozen history, and records each
   * answer. Returns, per bot, whether it answered and whether it has more to say.
   */
  async #runStep(message: PendingMessage, bots: string[], step: DiscussionStep | undefined): Promise<Map<string, { ok: boolean; moreToSay: boolean }>> {
    // Freeze the shared history before invoking any adapter. Each adapter gets
    // its own copy so a mutation cannot contaminate another bot's input.
    // All prompts are built before any bot starts, so bots in one step read
    // the same history and memory even if a file changes meanwhile.
    const input: RoundInput = { message: structuredClone(message), history: structuredClone(this.#history), ...(step ? { step: { ...step } } : {}) };
    let prepared: Awaited<ReturnType<Prepare>> | undefined;
    let prepareError: string | undefined;
    if (this.#prepare) {
      // Only the bots called in this step get a prompt.
      try { prepared = await this.#prepare({ ...structuredClone(input), message: { ...structuredClone(message), targets: [...bots] } }); }
      catch (error) { prepareError = error instanceof Error ? error.message : String(error); }
    }
    const outcomes = new Map<string, { ok: boolean; moreToSay: boolean }>();
    const results = await Promise.allSettled(bots.map(async bot => {
      let type: 'reply' | 'failure' = 'reply';
      let content: string;
      let requests: MemoryRequest[] = [];
      let moreToSay = true;
      const answeredBy: { model?: string; effort?: string } = {};
      try {
        if (prepareError !== undefined) throw new Error(prepareError);
        const entry = prepared?.[bot];
        if (this.#prepare && !entry) throw new Error('没有为该 bot 准备上下文');
        if (entry && 'error' in entry) throw new Error(entry.error);
        const output = await this.#bots[bot]({ ...structuredClone(input), ...(entry ? { prompt: entry.prompt, ...(entry.stable === undefined ? {} : { stable: entry.stable }) } : {}) });
        const reply = typeof output === 'string' ? output : output?.reply;
        if (typeof reply !== 'string') throw new Error('Bot returned non-text output');
        content = reply;
        if (typeof output !== 'string') {
          if (Array.isArray(output.memoryRequests)) requests = output.memoryRequests;
          if (output.moreToSay === false) moreToSay = false;
          for (const key of ['model', 'effort'] as const) if (typeof output[key] === 'string' && output[key]) answeredBy[key] = output[key];
        }
      } catch (error) { type = 'failure'; content = error instanceof Error ? error.message : String(error); }
      outcomes.set(bot, { ok: type === 'reply', moreToSay });
      await this.#serial(async () => {
        await this.#record({ kind: 'result', bot, message: { ...this.#result(bot, type, content), ...answeredBy, ...(step ? { discussion: step.round } : {}) } });
        // Only the answers to your own message may write memory. What bots say
        // to each other in a discussion must not become long-term memory.
        if (!requests.length || (step && step.round !== 1)) return;
        // The file is written first and the notice recorded after. A crash in
        // between loses the notice, never the memory; the file stays the truth.
        let notices: string[];
        if (!this.#applyMemory) notices = [`没有启用记忆写入，已忽略 ${bot} 的 ${requests.length} 条写记忆请求`];
        else try { notices = await this.#applyMemory({ bot, targets: message.targets, requests }); }
        catch (error) { notices = [`${bot} 的记忆写入失败：${error instanceof Error ? error.message : String(error)}`]; }
        for (const notice of notices) await this.#notice(notice);
      });
    }));
    const failedWrite = results.find(result => result.status === 'rejected');
    if (failedWrite?.status === 'rejected') throw failedWrite.reason;
    return outcomes;
  }

  #notice(text: string): Promise<void> {
    return this.#record({ kind: 'notice', message: this.#result('system', 'notice', text) });
  }

  // After the first answers: more steps until a limit says stop, then a summary.
  async #discuss(message: PendingMessage, first: Map<string, { ok: boolean; moreToSay: boolean }>): Promise<void> {
    if (message.targets.length < 2) { await this.#serial(() => this.#notice('只有一个 bot，不讨论')); return; }
    const rounds = message.discuss! + 1;
    const answered = new Set([...first].filter(([, outcome]) => outcome.ok).map(([bot]) => bot));
    let last = first;
    let stopped: string | undefined;
    for (let round = 2; round <= rounds; round++) {
      const bots = message.targets.filter(bot => last.get(bot)?.ok);
      if (this.#stopRequested) stopped = '已按你的要求停止讨论';
      else if (bots.length < 2) stopped = '能继续讨论的 bot 不到两个';
      // The first answers say nothing about the discussion, so at least one step always runs.
      else if (round > 2 && bots.every(bot => last.get(bot)?.moreToSay === false)) stopped = '各 bot 都表示没有新的要说';
      else stopped = this.#discussion?.canContinue?.(bots);
      if (stopped) break;
      await this.#serial(() => this.#record({ kind: 'step', step: { round, rounds }, bots }));
      last = await this.#runStep(message, bots, { round, rounds });
      for (const [bot, outcome] of last) if (outcome.ok) answered.add(bot);
    }
    if (stopped) await this.#serial(() => this.#notice(`讨论提前结束：${stopped}`));
    // The summary: by the default writer if it took part, else by the first bot that did.
    const writer = this.#discussion && answered.has(this.#discussion.defaultWriter) ? this.#discussion.defaultWriter : message.targets.find(bot => answered.has(bot));
    if (!writer) { await this.#serial(() => this.#notice('没有 bot 成功参与讨论，不写小结')); return; }
    const blocked = this.#discussion?.canContinue?.([writer]);
    if (blocked) { await this.#serial(() => this.#notice(`不写小结：${blocked}`)); return; }
    await this.#serial(() => this.#record({ kind: 'step', step: { round: 'summary', rounds }, bots: [writer] }));
    await this.#runStep(message, [writer], { round: 'summary', rounds });
  }
}

// A discussion needs a request for one and at least two bots to talk.
function discussing(message: PendingMessage): boolean {
  return message.discuss !== undefined && message.targets.length >= 2;
}
