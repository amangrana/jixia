import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCli } from './cli.ts';
import { createPreparer } from './context.ts';
import { createLimiter } from './limiter.ts';
import { createMemoryWriter } from './memory.ts';
import { Scheduler } from './scheduler.ts';
import type { LoginStatus } from './auth.ts';
import type { Config } from './config.ts';
import type { Bot, SchedulerEvent } from './scheduler.ts';

// Owns the data directory: one scheduler per group, the shared memory files,
// and the bots. Everything the HTTP layer does goes through here.

export type GroupInfo = { id: string; name: string; createdAt: string };
export type BotStatus = { name: string; provider: string; enabled: boolean; login: LoginStatus };
export type AppEvent =
  | ({ group: string } & SchedulerEvent)
  | { group: string; type: 'error'; message: string }
  | { type: 'groups'; groups: GroupInfo[] };

export class GroupNotFoundError extends Error {
  constructor() { super('群不存在'); this.name = 'GroupNotFoundError'; }
}

export type GroupsOptions = {
  /** The jixia folder: holds prompts/ and data/, and is what Claude Code may read. */
  root: string;
  config: Config;
  /** Login check result per bot name. */
  logins: Record<string, LoginStatus>;
  /** Test seam: replaces the real CLI-backed bots. */
  bots?: Record<string, Bot>;
};

// Folder names are app-generated IDs, never group names, so a name cannot
// reach outside the data directory.
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export class Groups {
  #options: GroupsOptions;
  #dir: { groups: string; memory: string; work: string };
  #infos = new Map<string, GroupInfo>();
  #schedulers = new Map<string, Promise<Scheduler>>();
  #bots: Record<string, Bot>;
  #statuses: BotStatus[];
  #applyMemory;
  #listeners = new Set<(event: AppEvent) => void>();

  private constructor(options: GroupsOptions) {
    this.#options = options;
    const data = join(options.root, 'data');
    this.#dir = { groups: join(data, 'groups'), memory: join(data, 'memory'), work: join(data, 'work') };
    const { config } = options;
    this.#applyMemory = createMemoryWriter({
      commonPath: join(this.#dir.memory, 'common.md'), selfPath: bot => join(this.#dir.memory, `${bot}.md`),
      defaultWriter: config.defaultWriter, maxMemoryTokens: config.maxMemoryTokens,
    });
    this.#statuses = Object.entries(config.bots).map(([name, bot]) => {
      const login = options.logins[name] ?? { kind: 'unknown' as const, detail: '没有登录检查结果' };
      return { name, provider: bot.provider, enabled: !config.requireSubscription || login.kind === 'subscription', login };
    });
    const limit = createLimiter(config.maxParallelCli);
    this.#bots = options.bots ?? Object.fromEntries(this.#statuses.map(status => {
      const bot = config.bots[status.name];
      // A bot that is not on a subscription login stays in the group but never
      // starts its CLI: every message to it fails with the reason, in view.
      const run: Bot = status.enabled
        ? input => limit(() => runCli({ provider: bot.provider, workDir: this.#dir.work, readDir: options.root, timeoutMs: config.cliTimeoutSeconds * 1000, model: bot.model, effort: bot.effort }, input.prompt!))
        : async () => { throw new Error(`${status.name} 未启用：${status.login.detail}。jixia 只走订阅登录；确认无误后可在 config.yaml 里把 requireSubscription 设为 false`); };
      return [status.name, run];
    }));
  }

  static async open(options: GroupsOptions): Promise<Groups> {
    const groups = new Groups(options);
    for (const directory of Object.values(groups.#dir)) await mkdir(directory, { recursive: true });
    for (const entry of await readdir(groups.#dir.groups, { withFileTypes: true })) {
      if (!entry.isDirectory() || !GROUP_ID.test(entry.name)) continue;
      try {
        const info = JSON.parse(await readFile(join(groups.#dir.groups, entry.name, 'group.json'), 'utf8')) as GroupInfo;
        groups.#infos.set(entry.name, { id: entry.name, name: String(info.name), createdAt: String(info.createdAt) });
      } catch { /* A folder without a readable group.json is not a group. */ }
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
    await writeFile(join(directory, 'group.json.tmp'), JSON.stringify(info, null, 2), 'utf8');
    await rename(join(directory, 'group.json.tmp'), join(directory, 'group.json'));
    this.#infos.set(info.id, info);
    await this.#scheduler(info.id);
    this.#emit({ type: 'groups', groups: this.list() });
    return info;
  }

  #open(id: string): Promise<Scheduler> {
    const directory = join(this.#dir.groups, id);
    const { root, config } = this.#options;
    const opening = Scheduler.open(directory, this.#bots, {
      prepare: createPreparer({
        systemPath: join(root, 'prompts', 'system.md'),
        commonPath: join(this.#dir.memory, 'common.md'), selfPath: bot => join(this.#dir.memory, `${bot}.md`),
        summaryPath: join(directory, 'summary.md'), recordsPath: join(directory, 'records.jsonl'),
        bots: Object.keys(this.#bots), defaultWriter: config.defaultWriter, maxPromptTokens: config.maxPromptTokens,
      }),
      applyMemory: this.#applyMemory,
      maxMessageTokens: config.maxMessageTokens,
      onEvent: event => this.#emit({ group: id, ...event }),
    });
    // Whatever was queued before this open (a restart, or a reopen after a
    // storage failure) continues without anyone having to send a new message.
    void opening.then(scheduler => this.#drain(id, scheduler), () => {});
    return opening;
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
