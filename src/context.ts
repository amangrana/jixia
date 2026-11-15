import { readFile } from 'node:fs/promises';
import { designatedWriter } from './routing.ts';
import { estimateTokens } from './tokens.ts';
import type { ChatMessage, Prepare } from './scheduler.ts';

// Builds the full prompt for one bot. Every call is a fresh headless session,
// so everything the bot should know has to be in here.

export const DEFAULT_MAX_PROMPT_TOKENS = 120_000;
export { estimateTokens };

export type Summary = { coveredThroughSeq: number; body: string };

// The summary file starts with a front-matter block recording how far it covers.
// A file without it is refused: guessing the boundary would silently drop or
// duplicate part of the conversation.
export function parseSummary(text: string): Summary {
  if (!text.trim()) return { coveredThroughSeq: 0, body: '' };
  const match = /^---\r?\ncoveredThroughSeq:\s*(\d+)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error('摘要文件缺少 coveredThroughSeq 文件头');
  return { coveredThroughSeq: Number(match[1]), body: text.slice(match[0].length).trim() };
}

// One JSON object per line. JSON keeps a message that quotes another message
// from being mistaken for a real one.
function renderMessage(message: ChatMessage): string {
  if (message.type === 'failure') return JSON.stringify({ seq: message.seq, from: message.from, failed: true });
  return JSON.stringify({ seq: message.seq, from: message.from, content: message.content });
}

export type PromptParts = {
  /** Content of prompts/system.md, with {{self}}, {{members}} and {{records}} placeholders. */
  system: string;
  bot: string;
  bots: readonly string[];
  recordsPath: string;
  common: string;
  self: string;
  summary: Summary;
  /** Full chat history up to, but not including, the current message. */
  history: readonly ChatMessage[];
  message: ChatMessage;
  /** Bot allowed to write common memory this round. */
  writer: string;
};

const section = (title: string, body: string) => `# ${title}\n${body.trim() || '（空）'}\n`;

// Fixed order, most stable first so a prompt cache can hit. The order is also
// the priority order from lowest to highest, as the design doc notes.
export function assemblePrompt(parts: PromptParts): string {
  const system = parts.system
    .replaceAll('{{self}}', parts.bot)
    .replaceAll('{{members}}', parts.bots.join('、'))
    .replaceAll('{{records}}', parts.recordsPath);
  const recent = parts.history.filter(message => message.seq > parts.summary.coveredThroughSeq);
  return [
    section('通用指令', system),
    section('公共记忆', parts.common),
    section('你的各自记忆', parts.self),
    section('对话摘要', parts.summary.body),
    section('摘要之后的原文', recent.map(renderMessage).join('\n')),
    section('当前用户消息', `本轮可以写公共记忆的 bot：${parts.writer}\n${renderMessage(parts.message)}`),
  ].join('\n');
}

const readOptional = async (path: string) => {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
};

export type ContextSources = {
  systemPath: string;
  commonPath: string;
  selfPath: (bot: string) => string;
  summaryPath: string;
  recordsPath: string;
  bots: readonly string[];
  defaultWriter: string;
  maxPromptTokens?: number;
};

// Reads every file once per round and builds all target bots' prompts before
// any CLI starts, so bots in the same round see the same history and memory.
export function createPreparer(sources: ContextSources): Prepare {
  const limit = sources.maxPromptTokens ?? DEFAULT_MAX_PROMPT_TOKENS;
  return async ({ message, history }) => {
    const current = history.at(-1);
    if (!current || current.id !== message.id) throw new Error('本轮历史的最后一条不是当前消息');
    // Shared inputs fail the round for everyone. A bot's own memory is private
    // input, so an unreadable file there fails only that bot.
    const [system, common, summaryText, selves] = await Promise.all([
      readFile(sources.systemPath, 'utf8'),
      readOptional(sources.commonPath),
      readOptional(sources.summaryPath),
      Promise.allSettled(message.targets.map(bot => readOptional(sources.selfPath(bot)))),
    ]);
    const summary = parseSummary(summaryText);
    const writer = designatedWriter(message.targets, sources.defaultWriter);
    return Object.fromEntries(message.targets.map((bot, index) => {
      const self = selves[index];
      if (self.status === 'rejected') return [bot, { error: `无法读取 ${bot} 的各自记忆：${self.reason instanceof Error ? self.reason.message : String(self.reason)}` }];
      const parts = { system, bot, bots: sources.bots, recordsPath: sources.recordsPath, common, self: self.value, summary, history: history.slice(0, -1), message: current, writer };
      const prompt = assemblePrompt(parts);
      const tokens = estimateTokens(prompt);
      if (tokens <= limit) return [bot, { prompt }];
      // Refuse rather than truncate: a silently shortened context gives answers
      // nobody can explain. Say which part is too big, because the remedies differ.
      const withoutHistory = estimateTokens(assemblePrompt({ ...parts, history: [], summary: { coveredThroughSeq: 0, body: '' } }));
      return [bot, { error: withoutHistory > limit
        ? `上下文过长，已拒绝调用：不算聊天历史就有约 ${withoutHistory} token，上限 ${limit}。请缩短这条消息或整理记忆文件`
        : `上下文过长，已拒绝调用：累计聊天历史过长（估算 ${tokens} token，上限 ${limit}），需要压缩后才能继续` }];
    }));
  };
}
