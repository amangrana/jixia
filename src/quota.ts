import { CLAUDE_CONTROL_ARGS } from './models.ts';
import type { Provider } from './cli.ts';
import type { OpenRpc, RunQuery } from './models.ts';

// How much of each subscription's usage limits is used. Read from the CLIs
// without calling a model, so it costs no quota. It is the whole account's
// usage, not just jixia's: chats and other CLI sessions count too.
// Both reads go through interfaces the CLIs do not promise to keep.

export type QuotaWindow = { usedPercent: number; /** ISO time, when the CLI says. */ resetsAt?: string };
export type Quota = { fiveHour?: QuotaWindow; weekly?: QuotaWindow };
export type QuotaState = {
  /** The last values read; kept when a later read fails. */
  quota?: Quota;
  /** When `quota` was read (ISO). */
  checkedAt?: string;
  /** Why the latest read failed; absent when it worked. */
  error?: string;
};

const percent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : undefined;
const isoTime = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString(); // Unix seconds
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
};
const window = (used: unknown, resets: unknown): QuotaWindow | undefined => {
  const usedPercent = percent(used);
  if (usedPercent === undefined) return undefined;
  const resetsAt = isoTime(resets);
  return { usedPercent, ...(resetsAt ? { resetsAt } : {}) };
};
const nonEmpty = (quota: Quota): Quota => {
  if (!quota.fiveHour && !quota.weekly) throw new Error('返回里没有额度数据');
  return quota;
};

export const CLAUDE_USAGE = JSON.stringify({ type: 'control_request', request_id: 'jixia-usage', request: { subtype: 'get_usage' } });

/** Stream-json output of Claude Code after a `get_usage` control request. */
export function parseClaudeUsage(stdout: string): Quota {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"control_response"')) continue;
    let response: { subtype?: string; error?: string; response?: { rate_limits_available?: boolean; rate_limits?: Record<string, { utilization?: unknown; resets_at?: unknown } | null> } } | undefined;
    try { response = (JSON.parse(line) as { response?: typeof response }).response; } catch { continue; }
    if (response?.subtype === 'error') throw new Error(response.error ?? 'Claude Code 拒绝了 get_usage 请求');
    const limits = response?.response?.rate_limits;
    if (response?.response?.rate_limits_available === false || !limits) throw new Error('Claude Code 没有提供额度数据');
    const fiveHour = window(limits.five_hour?.utilization, limits.five_hour?.resets_at);
    const weekly = window(limits.seven_day?.utilization, limits.seven_day?.resets_at);
    return nonEmpty({ ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) });
  }
  throw new Error('Claude Code 没有回应 get_usage 请求');
}

type CodexWindow = { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
/** Result of `account/rateLimits/read` from `codex app-server`. Windows are told apart by length, not by position. */
export function parseCodexUsage(result: unknown): Quota {
  const limits = (result as { rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow } } | null)?.rateLimits;
  if (!limits) throw new Error('Codex 没有返回额度数据');
  const quota: Quota = {};
  for (const entry of [limits.primary, limits.secondary]) {
    const minutes = entry?.windowDurationMins;
    const parsed = window(entry?.usedPercent, entry?.resetsAt);
    if (!parsed || typeof minutes !== 'number') continue;
    if (minutes <= 6 * 60) quota.fiveHour = parsed;
    else if (minutes >= 6 * 24 * 60) quota.weekly = parsed;
  }
  return nonEmpty(quota);
}

export async function queryQuota(provider: Provider, deps: { run: RunQuery; openCodex: OpenRpc }): Promise<Quota> {
  if (provider === 'claude') {
    const result = await deps.run('claude', CLAUDE_CONTROL_ARGS, CLAUDE_USAGE + '\n');
    if (result.timedOut) throw new Error('查询超时');
    return parseClaudeUsage(result.stdout);
  }
  const session = await deps.openCodex();
  try {
    await session.request('initialize', { clientInfo: { name: 'jixia', title: 'jixia', version: '1' } });
    return parseCodexUsage(await session.request('account/rateLimits/read', null));
  } finally { session.close(); }
}

export const QUOTA_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Reads every CLI's quota now and then every `intervalMs`. A read that fails
 * keeps the previous values and records why. `refresh` while a read is in
 * flight joins it, so a burst of clicks starts only one.
 */
export function createQuotaMonitor(options: { providers: Provider[]; deps: { run: RunQuery; openCodex: OpenRpc }; intervalMs?: number; now?: () => Date }) {
  const providers = [...new Set(options.providers)];
  const states: Partial<Record<Provider, QuotaState>> = {};
  const listeners = new Set<(states: Partial<Record<Provider, QuotaState>>) => void>();
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const snapshot = () => structuredClone(states);
  const read = async () => {
    await Promise.all(providers.map(async provider => {
      const previous = states[provider];
      try {
        states[provider] = { quota: await queryQuota(provider, options.deps), checkedAt: (options.now?.() ?? new Date()).toISOString() };
      } catch (error) {
        states[provider] = { ...(previous?.quota ? { quota: previous.quota, checkedAt: previous.checkedAt } : {}), error: error instanceof Error ? error.message : String(error) };
      }
    }));
    for (const listener of listeners) try { listener(snapshot()); } catch { /* listener's problem */ }
  };
  const refresh = (): Promise<void> => running ??= read().finally(() => { running = undefined; });
  return {
    refresh,
    get: snapshot,
    subscribe(listener: (states: Partial<Record<Provider, QuotaState>>) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { void refresh(); timer = setInterval(() => void refresh(), options.intervalMs ?? QUOTA_INTERVAL_MS); timer.unref(); },
    stop() { clearInterval(timer); },
  };
}
export type QuotaMonitor = ReturnType<typeof createQuotaMonitor>;
