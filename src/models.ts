import { mkdir, readFile } from 'node:fs/promises';
import { replaceFile } from './files.ts';
import { dirname } from 'node:path';
import { runProcess, subscriptionEnv } from './cli.ts';
import type { Provider } from './cli.ts';

// Which models each CLI offers and which effort levels each model accepts.
// Asked once at startup; neither query calls a model, so neither costs quota.
// Both go through interfaces the CLIs do not promise to keep (a debug command,
// the SDK control channel), so a failed query falls back to the last saved list.
//
// A model being listed does not prove this subscription may use it; a model
// that cannot be used fails when it is called, and the failure shows in the group.

export type ModelInfo = { id: string; name: string; efforts: string[] };
export type Catalog = {
  models: ModelInfo[];
  /** Effort levels offered while no model is chosen and the CLI picks one itself. */
  defaultEfforts: string[];
};
/** `note` is set when this start's query failed: the rest is then the last saved list, or empty. */
export type ModelList = Catalog & { note?: string };

/** A model or effort name is passed to a CLI as an argument and, for Codex, inside a TOML string. Plain tokens only. */
export const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;
const tokens = (value: unknown): string[] => Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : (item as { effort?: unknown })?.effort).filter((item): item is string => typeof item === 'string' && MODEL_TOKEN.test(item)) : [];

/** Output of `codex debug models`. Models the catalog marks as hidden are internal ones. */
export function parseCodexModels(stdout: string): Catalog {
  const data = JSON.parse(stdout) as { models?: unknown } | unknown[];
  const list = Array.isArray(data) ? data : (data as { models?: unknown }).models;
  if (!Array.isArray(list)) throw new Error('codex debug models 的输出里没有模型列表');
  const models = (list as Record<string, unknown>[])
    .filter(model => typeof model?.slug === 'string' && MODEL_TOKEN.test(model.slug) && model.visibility === 'list')
    .map(model => ({ id: model.slug as string, name: typeof model.display_name === 'string' ? model.display_name : model.slug as string, efforts: tokens(model.supported_reasoning_levels) }));
  if (!models.length) throw new Error('codex debug models 没有列出可选的模型');
  // Codex does not say which model it uses by default, so offer only the levels every listed model accepts.
  return { models, defaultEfforts: models[0].efforts.filter(effort => models.every(model => model.efforts.includes(effort))) };
}

export const CLAUDE_INIT = JSON.stringify({ type: 'control_request', request_id: 'jixia-models', request: { subtype: 'initialize' } });

/** Stream-json output of Claude Code after an `initialize` control request. */
export function parseClaudeModels(stdout: string): Catalog {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"control_response"')) continue;
    let list: unknown;
    try { list = (JSON.parse(line) as { response?: { response?: { models?: unknown } } }).response?.response?.models; } catch { continue; }
    if (!Array.isArray(list)) continue;
    const all = (list as Record<string, unknown>[])
      .filter(model => typeof model?.value === 'string' && MODEL_TOKEN.test(model.value))
      .map(model => ({ id: model.value as string, name: typeof model.displayName === 'string' ? model.displayName : model.value as string, efforts: tokens(model.supportedEffortLevels) }));
    // "default" describes what the CLI picks by itself. The app has its own
    // "no choice" entry for that, so it only keeps the entry's effort levels.
    const models = all.filter(model => model.id !== 'default');
    if (models.length) return { models, defaultEfforts: all.find(model => model.id === 'default')?.efforts ?? [] };
  }
  throw new Error('Claude Code 的初始化响应里没有模型列表');
}

export type RunQuery = (executable: string, args: string[], input: string) => Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }>;
const defaultRun = (cwd: string): RunQuery => (executable, args, input) => runProcess(executable, args, { cwd, input, timeoutMs: 30000, env: subscriptionEnv() });

export async function queryModels(provider: Provider, run: RunQuery): Promise<Catalog> {
  const result = provider === 'claude'
    // No prompt follows the control request; the CLI answers it and exits when stdin closes.
    ? await run('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''], CLAUDE_INIT + '\n')
    : await run('codex', ['debug', 'models'], '');
  if (result.timedOut) throw new Error('查询超时');
  // Claude Code may exit non-zero here because no prompt was given; the response is what counts.
  if (provider === 'codex' && result.exitCode !== 0) throw new Error(`退出码 ${result.exitCode}`);
  return provider === 'claude' ? parseClaudeModels(result.stdout) : parseCodexModels(result.stdout);
}

type Saved = Partial<Record<Provider, Catalog & { updatedAt: string }>>;
const NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const isTokens = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string' && MODEL_TOKEN.test(item));

/**
 * Asks each CLI for its models and saves the answers. A CLI whose query fails
 * keeps its previously saved list, with a note saying so. Never throws: the
 * model list is a convenience, and the bots work without it.
 */
export async function loadModels(options: { cachePath: string; providers: Provider[]; workDir: string; run?: RunQuery }): Promise<Record<Provider, ModelList>> {
  let saved: Saved = {};
  try { saved = JSON.parse(await readFile(options.cachePath, 'utf8')) as Saved; } catch { /* first start, or an unreadable file: start empty */ }
  if (typeof saved !== 'object' || saved === null) saved = {};
  const run = options.run ?? defaultRun(options.workDir);
  const lists: Record<Provider, ModelList> = { claude: { models: [], defaultEfforts: [] }, codex: { models: [], defaultEfforts: [] } };
  let changed = false;
  await Promise.all([...new Set(options.providers)].map(async provider => {
    try {
      const catalog = await queryModels(provider, run);
      lists[provider] = catalog;
      saved[provider] = { ...catalog, updatedAt: new Date().toISOString() };
      changed = true;
    } catch (error) {
      const old = saved[provider];
      // The saved file is only trusted as far as it still has the expected shape.
      const models = Array.isArray(old?.models) ? old.models.filter(model => typeof model?.id === 'string' && MODEL_TOKEN.test(model.id) && typeof model.name === 'string' && isTokens(model.efforts)) : [];
      const reason = error instanceof Error ? error.message : String(error);
      lists[provider] = {
        models, defaultEfforts: isTokens(old?.defaultEfforts) ? old.defaultEfforts : [],
        note: models.length ? `${NAME[provider]} 的模型列表没有更新（${reason}），沿用 ${String(old!.updatedAt).slice(0, 10)} 查到的列表` : `查不到 ${NAME[provider]} 的模型列表（${reason}），只能用默认模型`,
      };
    }
  }));
  if (changed) {
    try {
      await mkdir(dirname(options.cachePath), { recursive: true });
      await replaceFile(options.cachePath, JSON.stringify(saved, null, 2));
    } catch { /* the list still serves this run */ }
  }
  return lists;
}
