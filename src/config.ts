import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { MODEL_TOKEN } from './models.ts';
import type { Provider } from './cli.ts';

export type BotConfig = { provider: Provider; model?: string; effort?: string };
export type CompactConfig = {
  provider: Provider; model?: string; effort?: string;
  thresholdTokens: number; keepRounds: number; maxSummaryTokens: number;
};
export type Config = {
  compact: CompactConfig;
  port: number;
  bots: Record<string, BotConfig>;
  defaultWriter: string;
  cliTimeoutSeconds: number;
  maxParallelCli: number;
  maxPromptTokens: number;
  maxMessageTokens: number;
  maxMemoryTokens: number;
  requireSubscription: boolean;
  keepCliSessions: boolean;
  webSearch: boolean;
};

export const DEFAULT_CONFIG: Config = {
  port: 4517,
  bots: { claude: { provider: 'claude' }, chatgpt: { provider: 'codex' } },
  defaultWriter: 'claude',
  cliTimeoutSeconds: 300,
  maxParallelCli: 4,
  maxPromptTokens: 120_000,
  maxMessageTokens: 30_000,
  maxMemoryTokens: 8_000,
  requireSubscription: true,
  keepCliSessions: false,
  webSearch: false,
  compact: { provider: 'claude', model: 'sonnet', effort: 'low', thresholdTokens: 40_000, keepRounds: 3, maxSummaryTokens: 4_000 },
};

// Bot names become file names (memory/<name>.md) and @ mentions, so keep them plain.
const BOT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const RESERVED = new Set(['all', 'user', 'system', 'common']);

/** Merges user settings over the defaults and rejects anything it does not understand, so a typo cannot pass silently. */
export function resolveConfig(raw: unknown): Config {
  if (raw === null || raw === undefined) return structuredClone(DEFAULT_CONFIG);
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.yaml 的顶层必须是键值对');
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !(key in DEFAULT_CONFIG));
  if (unknown.length) throw new Error(`config.yaml 里有不认识的配置项：${unknown.join('、')}`);
  const config = { ...structuredClone(DEFAULT_CONFIG), ...input } as Config;
  for (const key of ['port', 'cliTimeoutSeconds', 'maxParallelCli', 'maxPromptTokens', 'maxMessageTokens', 'maxMemoryTokens'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`config.yaml：${key} 必须是正整数`);
  }
  if (config.port > 65535) throw new Error('config.yaml：port 超出范围');
  if (typeof config.requireSubscription !== 'boolean') throw new Error('config.yaml：requireSubscription 必须是 true 或 false');
  if (typeof config.keepCliSessions !== 'boolean') throw new Error('config.yaml：keepCliSessions 必须是 true 或 false');
  if (typeof config.webSearch !== 'boolean') throw new Error('config.yaml：webSearch 必须是 true 或 false');
  if (typeof config.bots !== 'object' || config.bots === null || Array.isArray(config.bots) || !Object.keys(config.bots).length) throw new Error('config.yaml：bots 至少要有一个 bot');
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!BOT_NAME.test(name) || RESERVED.has(name)) throw new Error(`config.yaml：bot 名字“${name}”不可用，只能用小写字母、数字、下划线和连字符，且不能是 all、user、system、common`);
    if (typeof bot !== 'object' || bot === null) throw new Error(`config.yaml：bot ${name} 的配置必须是键值对`);
    const extra = Object.keys(bot).filter(key => !['provider', 'model', 'effort'].includes(key));
    if (extra.length) throw new Error(`config.yaml：bot ${name} 有不认识的配置项：${extra.join('、')}`);
    if (bot.provider !== 'claude' && bot.provider !== 'codex') throw new Error(`config.yaml：bot ${name} 的 provider 只能是 claude 或 codex`);
    for (const key of ['model', 'effort'] as const) if (bot[key] !== undefined && (typeof bot[key] !== 'string' || !MODEL_TOKEN.test(bot[key]))) throw new Error(`config.yaml：bot ${name} 的 ${key} 必须是模型或档位的名称，只含字母、数字和 . _ : - [ ]`);
  }
  config.compact = resolveCompact(input.compact);
  if (config.compact.maxSummaryTokens >= config.compact.thresholdTokens) throw new Error('config.yaml：compact.maxSummaryTokens 必须小于 compact.thresholdTokens');
  if (!(config.defaultWriter in config.bots)) throw new Error(`config.yaml：defaultWriter“${config.defaultWriter}”不在 bots 里`);
  return config;
}

function resolveCompact(raw: unknown): CompactConfig {
  const defaults = structuredClone(DEFAULT_CONFIG.compact);
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config.yaml：compact 必须是键值对');
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !(key in defaults));
  if (unknown.length) throw new Error(`config.yaml：compact 里有不认识的配置项：${unknown.join('、')}`);
  // The default model and effort are Claude's; they must not follow a switch to Codex.
  if (input.provider === 'codex') { delete defaults.model; delete defaults.effort; }
  const compact = { ...defaults, ...input } as CompactConfig;
  if (compact.provider !== 'claude' && compact.provider !== 'codex') throw new Error('config.yaml：compact.provider 只能是 claude 或 codex');
  for (const key of ['model', 'effort'] as const) if (compact[key] !== undefined && (typeof compact[key] !== 'string' || !MODEL_TOKEN.test(compact[key]))) throw new Error(`config.yaml：compact.${key} 必须是模型或档位的名称，只含字母、数字和 . _ : - [ ]`);
  for (const key of ['thresholdTokens', 'keepRounds', 'maxSummaryTokens'] as const) {
    if (!Number.isInteger(compact[key]) || compact[key] < 1) throw new Error(`config.yaml：compact.${key} 必须是正整数`);
  }
  return compact;
}

/** A missing file means defaults. */
export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolveConfig(undefined); throw error; }
  return resolveConfig(parse(text));
}
