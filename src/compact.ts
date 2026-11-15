import { readFile } from 'node:fs/promises';
import { replaceFile } from './files.ts';
import { checkSummary, parseSummary, renderMessage } from './context.ts';
import { estimateTokens } from './tokens.ts';
import type { Summary } from './context.ts';
import type { ChatMessage } from './scheduler.ts';

// Replaces the older part of a group's conversation with one shared summary.
// The journal keeps every message; only what is sent to the models shrinks.

export type CompactSettings = {
  /** Summary plus the raw messages after it; above this, compress. */
  thresholdTokens: number;
  /** Finished rounds that always stay as raw text. */
  keepRounds: number;
  maxSummaryTokens: number;
  maxPromptTokens: number;
};
export type Conversation = { history: readonly ChatMessage[]; activeUserSeq: number | null };

const SECTIONS = ['当前有效的要求和决定', '每个 bot 各自的立场', '还没解决的问题', '任务分配', '关键事实与约束'];
const squeeze = (text: string) => text.replace(/\s+/g, '');

/** Last seq of every finished round, oldest first. A round is one user message and everything up to the next one. */
export function roundEnds({ history, activeUserSeq }: Conversation): number[] {
  const ends: number[] = [];
  history.forEach((message, index) => {
    const next = history[index + 1];
    if (next ? next.type === 'user' : activeUserSeq === null) ends.push(message.seq);
  });
  return ends;
}

export function compactPrompt(template: string, summary: Summary, messages: readonly ChatMessage[], maxSummaryTokens: number): string {
  // A character is never more than one estimated token, so a summary within
  // this many characters is always within the token cap.
  const instructions = template.replaceAll('{{maxChars}}', String(maxSummaryTokens));
  return [
    `# 压缩指令\n${instructions.trim()}\n`,
    `# 旧摘要${summary.coveredThroughSeq ? `（覆盖到 seq ${summary.coveredThroughSeq}）` : ''}\n${summary.body || '（无）'}\n`,
    `# 新增原文（seq ${messages[0].seq} 到 ${messages.at(-1)!.seq}）\n${messages.map(renderMessage).join('\n')}\n`,
  ].join('\n');
}

/** What to compress now, or null when nothing needs it. `through` becomes the new coveredThroughSeq. */
export function planCompact(conversation: Conversation, summary: Summary, settings: CompactSettings, template: string): { through: number; prompt: string } | null {
  const covered = summary.coveredThroughSeq;
  const fresh = conversation.history.filter(message => message.seq > covered);
  if (estimateTokens(summary.body) + estimateTokens(fresh.map(renderMessage).join('\n')) <= settings.thresholdTokens) return null;
  const ends = roundEnds(conversation);
  const cutoff = ends.at(-(settings.keepRounds + 1));
  if (cutoff === undefined || cutoff <= covered) return null;
  // Normally everything up to the cutoff goes in one call. When that would not
  // fit the prompt budget, take fewer rounds; the caller plans again afterwards.
  for (const through of ends.filter(end => end > covered && end <= cutoff).reverse()) {
    const prompt = compactPrompt(template, summary, fresh.filter(message => message.seq <= through), settings.maxSummaryTokens);
    if (estimateTokens(prompt) <= settings.maxPromptTokens) return { through, prompt };
  }
  throw new Error(`最早一轮还没压缩的原文加上旧摘要就超过了上下文预算（${settings.maxPromptTokens} token）`);
}

/** Refuses a summary that would lose the fixed structure or grow without bound. Returns the cleaned body. */
export function checkSummaryBody(text: unknown, maxSummaryTokens: number): string {
  if (typeof text !== 'string' || !text.trim()) throw new Error('压缩模型返回了空摘要');
  const body = text.trim();
  const flat = squeeze(body);
  let from = 0;
  for (const title of SECTIONS) {
    const at = flat.indexOf(squeeze(title), from);
    if (at === -1) throw new Error(`摘要缺少“${title}”一节，或五节的顺序不对`);
    from = at + 1;
  }
  const tokens = estimateTokens(body);
  if (tokens > maxSummaryTokens) throw new Error(`摘要过长：估算 ${tokens} token，上限 ${maxSummaryTokens}`);
  return body;
}

const readOptional = async (path: string) => {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
};

export type CompactorOptions = {
  summaryPath: string;
  templatePath: string;
  settings: CompactSettings;
  /** One model call: the compact prompt in, the new summary body out. */
  run: (prompt: string) => Promise<string>;
};

/**
 * One per group. The returned function checks the threshold and compresses if
 * needed, resolving to how many times it replaced the summary. A call while
 * one is in flight joins it: a group never has two compact tasks. On any
 * failure the old summary file is left as it was.
 */
export function createCompactor(options: CompactorOptions): (snapshot: () => Conversation) => Promise<number> {
  let running: Promise<number> | undefined;
  const work = async (snapshot: () => Conversation) => {
    const template = await readFile(options.templatePath, 'utf8');
    for (let done = 0; ; done++) {
      const conversation = snapshot();
      const summary = parseSummary(await readOptional(options.summaryPath));
      checkSummary(summary, conversation.history);
      const plan = planCompact(conversation, summary, options.settings, template);
      if (!plan) return done;
      const body = checkSummaryBody(await options.run(plan.prompt), options.settings.maxSummaryTokens);
      // Temp file then rename: a reader sees the old summary or the new one, never half of one.
      await replaceFile(options.summaryPath, `---\ncoveredThroughSeq: ${plan.through}\n---\n\n${body}\n`);
    }
  };
  return snapshot => running ??= work(snapshot).finally(() => { running = undefined; });
}
