import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runProcess, subscriptionEnv } from './cli.ts';
import { replaceFile } from './files.ts';
import type { Provider } from './cli.ts';

// Which models each CLI offers, which effort levels each model accepts, and
// what the CLI uses when told nothing. Asked once at startup; neither query
// calls a model, so neither costs quota. Both go through interfaces the CLIs
// do not promise to keep (the app-server protocol, the SDK control channel),
// so a failed query falls back to the last saved list.
//
// A model being listed does not prove this subscription may use it; a model
// that cannot be used fails when it is called, and the failure shows in the group.

export type ModelInfo = { id: string; name: string; efforts: string[]; /** What the CLI uses for this model when no effort is given, when it says. */ defaultEffort?: string };
export type Catalog = {
  models: ModelInfo[];
  /** Effort levels offered while no model is chosen and the CLI picks one itself. */
  defaultEfforts: string[];
  /** The model the CLI uses when none is given, when it says. `id` is what it reports in answers. */
  defaultModel?: { id: string; name: string };
  /** The effort the CLI uses when neither model nor effort is given, when it says. */
  defaultEffort?: string;
};
/**
 * The effort the CLI uses for this model when given none, if the startup query
 * said (Codex does, per model; Claude Code does not). No model means the CLI's default model.
 */
export function defaultEffortFor(list: Catalog, model: string | undefined): string | undefined {
  return model === undefined ? list.defaultEffort : list.models.find(entry => entry.id === model)?.defaultEffort;
}

/** `note` is set when this start's query failed: the rest is then the last saved list, or empty. */
export type ModelList = Catalog & { note?: string };

/** A model or effort name is passed to a CLI as an argument and, for Codex, inside a TOML string. Plain tokens only. */
export const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;
const isToken = (value: unknown): value is string => typeof value === 'string' && MODEL_TOKEN.test(value);
const tokens = (value: unknown): string[] => Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item : (item as { reasoningEffort?: unknown })?.reasoningEffort).filter(isToken)
  : [];

/** The `model/list` pages from `codex app-server`. Hidden models are internal ones. */
export function parseCodexModels(pages: unknown[]): Catalog {
  const items = pages.flatMap(page => Array.isArray((page as { data?: unknown })?.data) ? (page as { data: Record<string, unknown>[] }).data : []);
  let defaultModel: ModelInfo | undefined;
  const models: ModelInfo[] = [];
  for (const item of items) {
    // `model` is the name `--model` takes. When it is there but malformed, the
    // entry is dropped: `id` may be a different name the CLI would not accept.
    const name = typeof item?.model === 'string' ? item.model : item?.id;
    if (!isToken(name) || item.hidden === true || models.some(model => model.id === name)) continue;
    const id = name;
    const model: ModelInfo = { id, name: typeof item.displayName === 'string' && item.displayName ? item.displayName : id, efforts: tokens(item.supportedReasoningEfforts) };
    if (isToken(item.defaultReasoningEffort) && model.efforts.includes(item.defaultReasoningEffort)) model.defaultEffort = item.defaultReasoningEffort;
    models.push(model);
    if (item.isDefault === true) defaultModel = model;
  }
  if (!models.length) throw new Error('Codex 的 model/list 没有列出可选的模型');
  if (defaultModel) return { models, defaultEfforts: defaultModel.efforts, defaultModel: { id: defaultModel.id, name: defaultModel.name }, ...(defaultModel.defaultEffort ? { defaultEffort: defaultModel.defaultEffort } : {}) };
  // No default marked: offer only the levels every listed model accepts.
  return { models, defaultEfforts: models[0].efforts.filter(effort => models.every(model => model.efforts.includes(effort))) };
}

// Claude Code answers control requests on stdin without a prompt and exits when stdin closes.
export const CLAUDE_CONTROL_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''];
export const CLAUDE_INIT = JSON.stringify({ type: 'control_request', request_id: 'jixia-models', request: { subtype: 'initialize' } });

/** Stream-json output of Claude Code after an `initialize` control request. Claude Code does not say its default effort. */
export function parseClaudeModels(stdout: string): Catalog {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('"control_response"')) continue;
    let list: unknown;
    try { list = (JSON.parse(line) as { response?: { response?: { models?: unknown } } }).response?.response?.models; } catch { continue; }
    if (!Array.isArray(list)) continue;
    const entries = (list as Record<string, unknown>[]).filter(model => isToken(model?.value));
    const models = entries.filter(model => model.value !== 'default')
      .map(model => ({ id: model.value as string, name: typeof model.displayName === 'string' ? model.displayName : model.value as string, efforts: tokens(model.supportedEffortLevels) }));
    if (!models.length) continue;
    // "default" describes what the CLI picks by itself. The app has its own
    // "no choice" entry for that; it keeps the entry's model and effort levels.
    const entry = entries.find(model => model.value === 'default');
    const resolved = isToken(entry?.resolvedModel) ? entry.resolvedModel : undefined;
    // The description reads like "Opus 5.5 · Best for everyday, complex tasks".
    const name = typeof entry?.description === 'string' ? entry.description.split('·')[0].trim() : '';
    return { models, defaultEfforts: tokens(entry?.supportedEffortLevels), ...(resolved ? { defaultModel: { id: resolved, name: name || resolved } } : {}) };
  }
  throw new Error('Claude Code 的初始化响应里没有模型列表');
}

export type RunQuery = (executable: string, args: string[], input: string) => Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }>;
/** One JSON-RPC session with `codex app-server`. */
export type RpcSession = { request: (method: string, params: unknown) => Promise<unknown>; close: () => void };
export type OpenRpc = () => Promise<RpcSession>;

export const defaultRun = (cwd: string): RunQuery => (executable, args, input) => runProcess(executable, args, { cwd, input, timeoutMs: 30000, env: subscriptionEnv() });

// The app server answers over stdout, one JSON message per line, and exits as
// soon as stdin closes, so the connection stays open until the last answer.
export const openCodexAppServer = (cwd: string, timeoutMs = 30000): OpenRpc => async () => {
  const child = spawn('codex', ['app-server'], { cwd, env: subscriptionEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const failAll = (error: Error) => { for (const { reject } of waiting.values()) reject(error); waiting.clear(); };
  let buffer = '', nextId = 1;
  child.on('error', error => failAll(new Error(`无法启动 codex：${error.message}`)));
  child.on('exit', () => failAll(new Error('codex app-server 提前退出')));
  child.stdin.on('error', () => {});
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      const entry = message.id === undefined ? undefined : waiting.get(message.id);
      if (!entry) continue; // notifications
      waiting.delete(message.id!);
      if (message.error) entry.reject(new Error(message.error.message ?? 'app-server 返回错误'));
      else entry.resolve(message.result);
    }
  });
  const timer = setTimeout(() => { failAll(new Error('查询超时')); child.kill(); }, timeoutMs);
  const send = (payload: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  return {
    request: (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); send({ id, method, params }); }),
    close: () => { clearTimeout(timer); child.stdin.end(); setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000).unref(); },
  };
};

async function queryCodex(open: OpenRpc): Promise<Catalog> {
  const session = await open();
  try {
    await session.request('initialize', { clientInfo: { name: 'jixia', title: 'jixia', version: '1' } });
    const pages: unknown[] = [];
    let cursor: string | null = null;
    // Pages until the server stops giving a cursor; a hard cap guards against a loop.
    for (let page = 0; page < 20; page++) {
      const result = await session.request('model/list', cursor ? { cursor } : {}) as { nextCursor?: unknown };
      pages.push(result);
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    return parseCodexModels(pages);
  } finally { session.close(); }
}

export async function queryModels(provider: Provider, deps: { run: RunQuery; openCodex: OpenRpc }): Promise<Catalog> {
  if (provider === 'codex') return queryCodex(deps.openCodex);
  // No prompt follows the control request; the CLI answers it and exits when stdin closes.
  // Same setting isolation as the real calls, so "default" means what jixia's calls get.
  const result = await deps.run('claude', CLAUDE_CONTROL_ARGS, CLAUDE_INIT + '\n');
  if (result.timedOut) throw new Error('查询超时');
  // Claude Code may exit non-zero here because no prompt was given; the response is what counts.
  return parseClaudeModels(result.stdout);
}

type Saved = Partial<Record<Provider, Catalog & { updatedAt: string }>>;
const NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const isTokens = (value: unknown): value is string[] => Array.isArray(value) && value.every(isToken);

// The saved file is only trusted as far as it still has the expected shape.
function fromSaved(old: (Catalog & { updatedAt?: unknown }) | undefined): Catalog {
  const models = (Array.isArray(old?.models) ? old.models : [])
    .filter(model => isToken(model?.id) && typeof model.name === 'string' && isTokens(model.efforts))
    .map(model => ({ id: model.id, name: model.name, efforts: model.efforts, ...(isToken(model.defaultEffort) ? { defaultEffort: model.defaultEffort } : {}) }));
  const defaultModel = isToken(old?.defaultModel?.id) && typeof old.defaultModel.name === 'string' ? { id: old.defaultModel.id, name: old.defaultModel.name } : undefined;
  return { models, defaultEfforts: isTokens(old?.defaultEfforts) ? old.defaultEfforts : [], ...(defaultModel ? { defaultModel } : {}), ...(isToken(old?.defaultEffort) ? { defaultEffort: old.defaultEffort } : {}) };
}

/**
 * Asks each CLI for its models and saves the answers. A CLI whose query fails
 * keeps its previously saved list, with a note saying so. Never throws: the
 * model list is a convenience, and the bots work without it.
 */
export async function loadModels(options: { cachePath: string; providers: Provider[]; workDir: string; run?: RunQuery; openCodex?: OpenRpc }): Promise<Record<Provider, ModelList>> {
  let saved: Saved = {};
  try { saved = JSON.parse(await readFile(options.cachePath, 'utf8')) as Saved; } catch { /* first start, or an unreadable file: start empty */ }
  if (typeof saved !== 'object' || saved === null) saved = {};
  const deps = { run: options.run ?? defaultRun(options.workDir), openCodex: options.openCodex ?? openCodexAppServer(options.workDir) };
  const lists: Record<Provider, ModelList> = { claude: { models: [], defaultEfforts: [] }, codex: { models: [], defaultEfforts: [] } };
  let changed = false;
  await Promise.all([...new Set(options.providers)].map(async provider => {
    try {
      const catalog = await queryModels(provider, deps);
      lists[provider] = catalog;
      saved[provider] = { ...catalog, updatedAt: new Date().toISOString() };
      changed = true;
    } catch (error) {
      const old = saved[provider];
      const catalog = fromSaved(old);
      const reason = error instanceof Error ? error.message : String(error);
      lists[provider] = {
        ...catalog,
        note: catalog.models.length ? `${NAME[provider]} 的模型列表没有更新（${reason}），沿用 ${String(old!.updatedAt).slice(0, 10)} 查到的列表` : `查不到 ${NAME[provider]} 的模型列表（${reason}），只能用默认模型`,
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
