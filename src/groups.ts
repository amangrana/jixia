import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { renameWithRetry, replaceFile } from './files.ts';
import { join } from 'node:path';
import { runCli } from './cli.ts';
import { createCompactor } from './compact.ts';
import { createPreparer } from './context.ts';
import { createLimiter } from './limiter.ts';
import { createMemory } from './memory.ts';
import type { Memory } from './memory.ts';
import { defaultEffortFor, MODEL_TOKEN } from './models.ts';
import type { Provider } from './cli.ts';
import type { ModelList } from './models.ts';
import { Scheduler } from './scheduler.ts';
import type { LoginStatus } from './auth.ts';
import type { Config } from './config.ts';
import type { Bot, SchedulerEvent } from './scheduler.ts';

// Owns the data directory: one scheduler per group, the shared memory files,
// and the bots. Everything the HTTP layer does goes through here.

export type GroupInfo = { id: string; name: string; createdAt: string };
export type BotStatus = { name: string; provider: string; enabled: boolean; login: LoginStatus; models: ModelList };
/** What one bot is asked to use in a group. A missing field means "let the CLI decide". */
export type Choice = { model?: string; effort?: string };
export type Selection = Record<string, Choice>;
export type AppEvent =
  | ({ group: string } & SchedulerEvent)
  | { group: string; type: 'selection'; selection: Selection }
  | { group: string; type: 'error'; message: string }
  | { type: 'groups'; groups: GroupInfo[] }
  | { type: 'memory'; name: string };

export class GroupNotFoundError extends Error {
  constructor() { super('群不存在'); this.name = 'GroupNotFoundError'; }
}
export class GroupBusyError extends Error {
  constructor() { super('这个群正在回答，等这一轮结束后再删'); this.name = 'GroupBusyError'; }
}

export type GroupsOptions = {
  /** The jixia folder: holds prompts/ and data/, and is what Claude Code may read. */
  root: string;
  config: Config;
  /** Login check result per bot name. */
  logins: Record<string, LoginStatus>;
  /** Model lists from the startup query, per CLI. Without it the dropdowns only offer the default. */
  models?: Partial<Record<Provider, ModelList>>;
  /** Test seam: replaces the real CLI-backed bots. Compaction is then off unless `summarize` is given too. */
  bots?: Record<string, Bot>;
  /** Test seam: replaces the CLI call that writes a summary. */
  summarize?: (prompt: string) => Promise<string>;
};

// Folder names are app-generated IDs, never group names, so a name cannot
// reach outside the data directory.
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Keeps only well-formed choices. A bot whose entry is malformed is dropped (and
// so falls back to its default); null and '' mean "not chosen".
function cleanSelection(raw: unknown): Selection {
  const result: Selection = {};
  if (typeof raw !== 'object' || raw === null) return result;
  for (const [bot, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const choice: Choice = {};
    let valid = true;
    for (const key of ['model', 'effort'] as const) {
      const field = (value as Record<string, unknown>)[key];
      if (field === undefined || field === null || field === '') continue;
      if (typeof field === 'string' && MODEL_TOKEN.test(field)) choice[key] = field; else valid = false;
    }
    if (valid) result[bot] = choice;
  }
  return result;
}

export class Groups {
  #options: GroupsOptions;
  #dir: { groups: string; memory: string; work: string };
  #infos = new Map<string, GroupInfo>();
  #schedulers = new Map<string, Promise<Scheduler>>();
  #bots: Record<string, Bot>;
  #statuses: BotStatus[];
  #applyMemory;
  /** The memory files: bots' write requests and edits from the memory page share one lock. */
  readonly memory: Memory;
  #summarize: ((prompt: string) => Promise<string>) | undefined;
  #compactors = new Map<string, ReturnType<typeof createCompactor>>();
  // What was saved for each group. A bot missing from it uses the config default.
  #selections = new Map<string, Selection>();
  #listeners = new Set<(event: AppEvent) => void>();

  private constructor(options: GroupsOptions) {
    this.#options = options;
    const data = join(options.root, 'data');
    this.#dir = { groups: join(data, 'groups'), memory: join(data, 'memory'), work: join(data, 'work') };
    const { config } = options;
    this.memory = createMemory({
      commonPath: join(this.#dir.memory, 'common.md'), selfPath: bot => join(this.#dir.memory, `${bot}.md`),
      defaultWriter: config.defaultWriter, maxMemoryTokens: config.maxMemoryTokens, bots: Object.keys(config.bots),
    });
    this.#applyMemory = this.memory.apply;
    // The memory page refreshes a file when it changes, whoever wrote it.
    this.memory.subscribe(name => this.#emit({ type: 'memory', name }));
    this.#statuses = Object.entries(config.bots).map(([name, bot]) => {
      const login = options.logins[name] ?? { kind: 'unknown' as const, detail: '没有登录检查结果' };
      return { name, provider: bot.provider, enabled: !config.requireSubscription || login.kind === 'subscription', login, models: options.models?.[bot.provider] ?? { models: [], defaultEfforts: [] } };
    });
    const limit = createLimiter(config.maxParallelCli);
    this.#bots = options.bots ?? Object.fromEntries(this.#statuses.map(status => {
      const bot = config.bots[status.name];
      // A bot that is not on a subscription login stays in the group but never
      // starts its CLI: every message to it fails with the reason, in view.
      const run: Bot = status.enabled
        ? input => limit(() => runCli({ provider: bot.provider, workDir: this.#dir.work, readDir: options.root, timeoutMs: config.cliTimeoutSeconds * 1000, model: input.model, effort: input.effort, defaultModel: status.models.defaultModel?.id, defaultEffort: defaultEffortFor(status.models, input.model) }, input.prompt!, input.stable))
        : async () => { throw new Error(`${status.name} 未启用：${status.login.detail}。jixia 只走订阅登录；确认无误后可在 config.yaml 里把 requireSubscription 设为 false`); };
      return [status.name, run];
    }));
    // Compaction goes through the same subscription check and the same global
    // CLI limit as the bots. Its login is that of any bot on the same CLI.
    const { compact } = config;
    const allowed = !config.requireSubscription || this.#statuses.some(status => status.provider === compact.provider && status.login.kind === 'subscription');
    this.#summarize = options.summarize ?? (options.bots ? undefined : allowed
      ? async prompt => (await limit(() => runCli({ provider: compact.provider, workDir: this.#dir.work, readDir: options.root, timeoutMs: config.cliTimeoutSeconds * 1000, model: compact.model, effort: compact.effort }, prompt))).reply
      : async () => { throw new Error(`没有可用的 ${compact.provider} 订阅登录`); });
  }

  static async open(options: GroupsOptions): Promise<Groups> {
    const groups = new Groups(options);
    for (const directory of Object.values(groups.#dir)) await mkdir(directory, { recursive: true });
    for (const entry of await readdir(groups.#dir.groups, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GROUP_ID.test(entry.name)) continue;
      try {
        const info = JSON.parse(await readFile(join(groups.#dir.groups, entry.name, 'group.json'), 'utf8')) as GroupInfo;
        groups.#infos.set(entry.name, { id: entry.name, name: String(info.name), createdAt: String(info.createdAt) });
      } catch { continue; /* A folder without a readable group.json is not a group. */ }
      // A group from before this setting existed, or with an unreadable file, uses the config defaults.
      try { groups.#selections.set(entry.name, cleanSelection(JSON.parse(await readFile(join(groups.#dir.groups, entry.name, 'settings.json'), 'utf8')).models)); } catch { /* defaults */ }
    }
    // Open every group now: this closes rounds a restart interrupted and
    // resumes queued messages without waiting for the user to click the group.
    await Promise.all([...groups.#infos.keys()].map(id => groups.#scheduler(id).catch(() => {})));
    return groups;
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(event: AppEvent): void {
    for (const listener of this.#listeners) try { listener(event); } catch { /* listener's problem */ }
  }

  get bots(): BotStatus[] { return structuredClone(this.#statuses); }
  list(): GroupInfo[] { return [...this.#infos.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)); }
  info(id: string): GroupInfo {
    const info = this.#infos.get(id);
    if (!info) throw new GroupNotFoundError();
    return info;
  }

  async create(name: unknown): Promise<GroupInfo> {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new RangeError('群名不能为空，且不超过 100 个字符');
    const info: GroupInfo = { id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString() };
    const directory = join(this.#dir.groups, info.id);
    await mkdir(directory);
    await replaceFile(join(directory, 'group.json'), JSON.stringify(info, null, 2));
    this.#infos.set(info.id, info);
    // A new group starts from the config defaults and keeps its own copy from
    // here on, so a later change to config.yaml does not move existing groups.
    await this.#saveSelection(info.id, this.#defaults());
    await this.#scheduler(info.id);
    this.#emit({ type: 'groups', groups: this.list() });
    return info;
  }

  #defaults(): Selection {
    return Object.fromEntries(Object.entries(this.#options.config.bots).map(([name, bot]) => [name, { ...(bot.model ? { model: bot.model } : {}), ...(bot.effort ? { effort: bot.effort } : {}) }]));
  }

  async #saveSelection(id: string, selection: Selection): Promise<void> {
    const file = join(this.#dir.groups, id, 'settings.json');
    await replaceFile(file, JSON.stringify({ models: selection }, null, 2));
    this.#selections.set(id, selection);
  }

  /** The model and effort each bot uses in this group right now. */
  selection(id: string): Selection {
    this.info(id);
    const saved = this.#selections.get(id), defaults = this.#defaults();
    return Object.fromEntries(Object.keys(this.#bots).map(name => [name, { ...(saved?.[name] ?? defaults[name] ?? {}) }]));
  }

  /**
   * Changes what one bot uses in this group. It applies to every round that
   * starts afterwards, messages already queued included; a running round keeps
   * what it started with. An empty value means "let the CLI decide".
   */
  async select(id: string, bot: string, choice: { model?: unknown; effort?: unknown }): Promise<Selection> {
    const status = this.#statuses.find(entry => entry.name === bot);
    if (!status || !(bot in this.#bots)) throw new RangeError(`没有名为 ${bot} 的 bot`);
    const clean = cleanSelection({ [bot]: choice })[bot];
    if (!clean) throw new RangeError('model 和 effort 必须是模型或档位的名称，或者留空');
    // Check against the startup list when there is one. Without a list the
    // names cannot be checked here; a wrong one fails when the CLI is called.
    const { models, defaultEfforts } = status.models;
    if (models.length) {
      const model = clean.model === undefined ? undefined : models.find(entry => entry.id === clean.model);
      if (clean.model !== undefined && !model) throw new RangeError(`${bot} 的模型列表里没有 ${clean.model}`);
      const efforts = model ? model.efforts : defaultEfforts;
      if (clean.effort !== undefined && !efforts.includes(clean.effort)) throw new RangeError(`${model ? model.id : '默认模型'} 不支持 effort ${clean.effort}`);
    }
    const next = { ...this.selection(id), [bot]: clean };
    await this.#saveSelection(id, next);
    this.#emit({ group: id, type: 'selection', selection: this.selection(id) });
    return this.selection(id);
  }

  #open(id: string): Promise<Scheduler> {
    const directory = join(this.#dir.groups, id);
    const { root, config } = this.#options;
    // Each bot reads the group's choice when it is invoked, which is right
    // after the round's prompts are built: one choice per round, taken at its start.
    const bots = Object.fromEntries(Object.entries(this.#bots).map(([name, run]): [string, Bot] => [name, input => run({ ...input, ...this.selection(id)[name] })]));
    const opening = Scheduler.open(directory, bots, {
      prepare: createPreparer({
        systemPath: join(root, 'prompts', 'system.md'),
        commonPath: join(this.#dir.memory, 'common.md'), selfPath: bot => join(this.#dir.memory, `${bot}.md`),
        summaryPath: join(directory, 'summary.md'), recordsPath: join(directory, 'records.jsonl'),
        bots: Object.keys(this.#bots), defaultWriter: config.defaultWriter, maxPromptTokens: config.maxPromptTokens,
      }),
      applyMemory: this.#applyMemory,
      maxMessageTokens: config.maxMessageTokens,
      onEvent: event => {
        this.#emit({ group: id, ...event });
        // A round just finished: check in the background whether the conversation needs compressing.
        if (event.type === 'round' && event.round === null) void opening.then(scheduler => this.#compact(id, scheduler), () => {});
      },
    });
    // Whatever was queued before this open (a restart, or a reopen after a
    // storage failure) continues without anyone having to send a new message.
    // The compact check here picks up one that a restart or a failure cut short.
    void opening.then(scheduler => { this.#drain(id, scheduler); this.#compact(id, scheduler); }, () => {});
    return opening;
  }

  // Never awaited by the round: answers show up first, the summary catches up.
  // A round that starts meanwhile uses the old summary plus more raw text.
  #compact(id: string, scheduler: Scheduler): void {
    if (!this.#summarize || scheduler.needsReopen) return;
    let compactor = this.#compactors.get(id);
    if (!compactor) {
      const { root, config } = this.#options;
      compactor = createCompactor({
        summaryPath: join(this.#dir.groups, id, 'summary.md'), templatePath: join(root, 'prompts', 'compact.md'),
        settings: { thresholdTokens: config.compact.thresholdTokens, keepRounds: config.compact.keepRounds, maxSummaryTokens: config.compact.maxSummaryTokens, maxPromptTokens: config.maxPromptTokens },
        run: this.#summarize,
      });
      this.#compactors.set(id, compactor);
    }
    compactor(() => ({ history: scheduler.history, activeUserSeq: scheduler.round?.userSeq ?? null }))
      .catch(error => {
        // A group deleted mid-compaction has no folder left to write into; that is expected, not a failure.
        if (this.#infos.has(id)) this.#emit({ group: id, type: 'error', message: `压缩对话失败，继续使用旧摘要，下一轮结束后重试：${message(error)}` });
      });
  }

  /**
   * Deletes a group: its folder moves to data/deleted/, from where it can be
   * moved back by hand. Refused while the group is answering, since a running
   * round cannot be cancelled. Memory it wrote stays: memory is shared.
   */
  async remove(id: string): Promise<GroupInfo> {
    const info = this.info(id);
    const scheduler = await this.#scheduler(id);
    // In the scheduler's own order: either no round is running and none will
    // start, or a round is running and nothing changes.
    if (!(await scheduler.retire())) throw new GroupBusyError();
    this.#infos.delete(id);
    this.#schedulers.delete(id);
    this.#compactors.delete(id);
    const selection = this.#selections.get(id);
    this.#selections.delete(id);
    try {
      const deleted = join(this.#options.root, 'data', 'deleted');
      await mkdir(deleted, { recursive: true });
      await renameWithRetry(join(this.#dir.groups, id), join(deleted, id), 8);
    } catch (error) {
      // The folder is still in place: put the group back. Its scheduler is
      // retired, so the next use opens a fresh one from the journal.
      this.#infos.set(id, info);
      if (selection) this.#selections.set(id, selection);
      throw new Error(`无法移动群文件夹，群没有删除：${message(error)}。可能有程序正开着里面的文件`);
    }
    this.#emit({ type: 'groups', groups: this.list() });
    return info;
  }

  #drain(id: string, scheduler: Scheduler): void {
    scheduler.runUntilIdle().catch(error => this.#emit({ group: id, type: 'error', message: `处理队列时出错：${message(error)}。下次操作这个群时会自动重新打开` }));
  }

  // A scheduler that hit a storage failure refuses all work; replace it. The
  // new one replays the journal and closes the interrupted round.
  async #scheduler(id: string): Promise<Scheduler> {
    this.info(id);
    for (;;) {
      let current = this.#schedulers.get(id);
      if (!current) { current = this.#open(id); this.#schedulers.set(id, current); }
      let scheduler: Scheduler | undefined;
      try { scheduler = await current; } catch (error) {
        if (this.#schedulers.get(id) === current) this.#schedulers.delete(id);
        throw error;
      }
      if (!scheduler.needsReopen) return scheduler;
      if (this.#schedulers.get(id) === current) this.#schedulers.delete(id);
    }
  }

  /** Runs an action on the group's scheduler, reopening it once if it had stopped after a storage failure. */
  async use<T>(id: string, action: (scheduler: Scheduler) => Promise<T> | T): Promise<T> {
    const scheduler = await this.#scheduler(id);
    try { return await action(scheduler); }
    catch (error) {
      if (!scheduler.needsReopen) throw error;
      return action(await this.#scheduler(id));
    }
  }

  /** Call after anything that may have added work to the queue. */
  kick(id: string): void {
    this.#scheduler(id).then(scheduler => this.#drain(id, scheduler), () => {});
  }
}
