import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assemblePrompt, createPreparer, estimateTokens, parseSummary } from '../src/context.ts';
import { designatedWriter } from '../src/routing.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { ChatMessage } from '../src/scheduler.ts';

const msg = (seq: number, from: string, content: string, type: ChatMessage['type'] = from === 'user' ? 'user' : 'reply'): ChatMessage =>
  ({ seq, id: `id-${seq}`, ts: '2026-11-15T00:00:00.000Z', from, type, content });

test('token estimate counts CJK characters whole and other text by quarters', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('中文测试'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens('中文abcde'), 4);
});

test('summary header gives the covered range; a missing header is refused', () => {
  assert.deepEqual(parseSummary(''), { coveredThroughSeq: 0, body: '' });
  assert.deepEqual(parseSummary('---\ncoveredThroughSeq: 12\n---\n## 1. 要求\n- 端口 43128\n'), { coveredThroughSeq: 12, body: '## 1. 要求\n- 端口 43128' });
  assert.deepEqual(parseSummary('---\r\ncoveredThroughSeq: 3\r\n---\r\n正文'), { coveredThroughSeq: 3, body: '正文' });
  assert.throws(() => parseSummary('## 1. 要求\n没有文件头'), /coveredThroughSeq/);
});

test('the default writer writes common memory unless the message singles out one bot', () => {
  assert.equal(designatedWriter(['claude', 'chatgpt'], 'claude'), 'claude');
  assert.equal(designatedWriter(['chatgpt'], 'claude'), 'chatgpt');
});

test('prompt sections come in the fixed order, with only post-summary messages as raw text', () => {
  const prompt = assemblePrompt({
    system: '你是 {{self}}，成员：{{members}}，记录：{{records}}',
    bot: 'claude', bots: ['claude', 'chatgpt'], recordsPath: 'D:\\data\\g1\\records.jsonl',
    common: '[2026-11-10] 偏好简短回答', self: '',
    summary: { coveredThroughSeq: 2, body: '## 1. 当前有效的要求和决定\n- 端口 43128(seq1)' },
    history: [msg(1, 'user', '旧消息一'), msg(2, 'claude', '旧回答'), msg(3, 'user', '问题三'), msg(4, 'chatgpt', '回答"四"\n第二行'), msg(5, 'claude', 'timeout', 'failure')],
    message: msg(6, 'user', '@claude 你怎么看'),
    writer: 'claude',
  });
  const titles = [...prompt.matchAll(/^# (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(titles, ['通用指令', '公共记忆', '你的各自记忆', '对话摘要', '摘要之后的原文', '当前用户消息']);
  assert.match(prompt, /你是 claude，成员：claude、chatgpt，记录：D:\\data\\g1\\records\.jsonl/);
  assert.match(prompt, /# 你的各自记忆\n（空）/);
  assert(!prompt.includes('旧消息一') && !prompt.includes('旧回答'));
  assert(prompt.includes('{"seq":3,"from":"user","content":"问题三"}'));
  // Quotes and newlines stay inside one JSON line; a failure carries no error text.
  assert(prompt.includes('{"seq":4,"from":"chatgpt","content":"回答\\"四\\"\\n第二行"}'));
  assert(prompt.includes('{"seq":5,"from":"claude","failed":true}'));
  assert(prompt.trimEnd().endsWith('本轮可以写公共记忆的 bot：claude\n{"seq":6,"from":"user","content":"@claude 你怎么看"}'));
});

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.cwd(), '.context-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'system.md'), '你是 {{self}}');
  const sources = (maxPromptTokens?: number) => ({
    systemPath: join(directory, 'system.md'), commonPath: join(directory, 'common.md'),
    selfPath: (bot: string) => join(directory, `${bot}.md`), summaryPath: join(directory, 'summary.md'),
    recordsPath: join(directory, 'records.jsonl'), bots: ['claude', 'chatgpt'], defaultWriter: 'claude', maxPromptTokens,
  });
  return { directory, sources };
}

test('one round: every bot gets its own prompt built from the same snapshot before any bot starts', async t => {
  const { directory, sources } = await workspace(t);
  await writeFile(join(directory, 'common.md'), '公共内容-一');
  await writeFile(join(directory, 'chatgpt.md'), 'chatgpt 的私有内容');
  const prompts: Record<string, string[]> = { claude: [], chatgpt: [] };
  const bot = (name: string) => async (input: { prompt?: string }) => {
    // A change after the round started must not reach a bot in the same round.
    await writeFile(join(directory, 'common.md'), '公共内容-二');
    prompts[name].push(input.prompt!);
    return `${name} 的回答`;
  };
  const scheduler = await Scheduler.open(directory, { claude: bot('claude'), chatgpt: bot('chatgpt') }, { prepare: createPreparer(sources()) });
  await scheduler.enqueue({ id: 'm1', content: '第一个问题' });
  await scheduler.enqueue({ id: 'm2', content: '@chatgpt 第二个问题' });
  await scheduler.runUntilIdle();
  for (const name of ['claude', 'chatgpt']) {
    assert.match(prompts[name][0], new RegExp(`你是 ${name}`));
    assert(prompts[name][0].includes('公共内容-一') && !prompts[name][0].includes('公共内容-二'));
    assert(prompts[name][0].includes('本轮可以写公共记忆的 bot：claude'));
  }
  assert(prompts.chatgpt[0].includes('chatgpt 的私有内容') && !prompts.claude[0].includes('chatgpt 的私有内容'));
  // The next round sees the previous round's answers and the updated memory.
  assert.equal(prompts.claude.length, 1);
  const second = prompts.chatgpt[1];
  assert(second.includes('claude 的回答') && second.includes('chatgpt 的回答') && second.includes('公共内容-二'));
  assert(second.includes('本轮可以写公共记忆的 bot：chatgpt'));
  assert.equal(second.match(/第二个问题/g)?.length, 1);
});

test('an over-budget prompt is refused without calling the bot, and says which part is too big', async t => {
  const { directory, sources } = await workspace(t);
  const calls: string[] = [];
  const scheduler = await Scheduler.open(directory, { claude: async input => { calls.push(input.message.id); return '回答'.repeat(150); } }, { prepare: createPreparer({ ...sources(400), bots: ['claude'] }) });
  // Each round fits on its own; together with the earlier answers the third does not.
  for (const id of ['one', 'two', 'three']) await scheduler.enqueue({ id, content: '问题' });
  // This single message is over the prompt limit by itself (but under the per-message cap).
  await scheduler.enqueue({ id: 'huge', content: '很长的消息'.repeat(100) });
  await scheduler.runUntilIdle();
  const failures = scheduler.history.filter(m => m.type === 'failure').map(m => m.content);
  assert.deepEqual(calls, ['one', 'two']);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /累计聊天历史过长（估算 \d+ token，上限 400），需要压缩后才能继续/);
  assert.match(failures[1], /不算聊天历史就有约 \d+ token，上限 400。请缩短这条消息或整理记忆文件/);
});

test('an unreadable private memory fails only its own bot; the other bot answers', async t => {
  const { directory, sources } = await workspace(t);
  await mkdir(join(directory, 'claude.md')); // A directory: a real read error, unlike a missing file.
  const calls: string[] = [];
  const bot = (name: string) => async () => { calls.push(name); return `${name} 的回答`; };
  const scheduler = await Scheduler.open(directory, { claude: bot('claude'), chatgpt: bot('chatgpt') }, { prepare: createPreparer(sources()) });
  await scheduler.enqueue({ id: 'm1', content: '问题' });
  await scheduler.runUntilIdle();
  assert.deepEqual(calls, ['chatgpt']);
  const byBot = Object.fromEntries(scheduler.history.filter(m => m.from !== 'user').map(m => [m.from, m]));
  assert.equal(byBot.chatgpt.type, 'reply');
  assert.equal(byBot.claude.type, 'failure');
  assert.match(byBot.claude.content, /无法读取 claude 的各自记忆/);
});

test('a broken summary file fails the round for every bot instead of guessing', async t => {
  const { directory, sources } = await workspace(t);
  await writeFile(join(directory, 'summary.md'), '没有文件头的摘要');
  let calls = 0;
  const bot = async () => { calls++; return 'ok'; };
  const scheduler = await Scheduler.open(directory, { claude: bot, chatgpt: bot }, { prepare: createPreparer(sources()) });
  await scheduler.enqueue({ id: 'm1', content: '问题' });
  await scheduler.runUntilIdle();
  assert.equal(calls, 0);
  assert.deepEqual(scheduler.history.filter(m => m.type === 'failure').map(m => m.content), ['摘要文件缺少 coveredThroughSeq 文件头', '摘要文件缺少 coveredThroughSeq 文件头']);
});
