import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSummaryBody, createCompactor, planCompact, roundEnds } from '../src/compact.ts';
import { resolveConfig } from '../src/config.ts';
import { checkSummary, createPreparer, parseSummary } from '../src/context.ts';
import { Groups } from '../src/groups.ts';
import type { AppEvent } from '../src/groups.ts';
import type { ChatMessage } from '../src/scheduler.ts';

const BODY = '## 1. 当前有效的要求和决定\n- 端口 43128（seq 1）\n\n## 2. 每个 bot 各自的立场\n（无）\n\n## 3. 还没解决的问题\n（无）\n\n## 4. 任务分配\n（无）\n\n## 5. 关键事实与约束\n- const retries = 2;';
const TEMPLATE = '压缩，最多 {{maxChars}} 字符';
const settings = { thresholdTokens: 100, keepRounds: 3, maxSummaryTokens: 500, maxPromptTokens: 100_000 };

// Each round: a user message and two answers. Seqs are 1,2,3 / 4,5,6 / ...
function rounds(count: number, text = '讨论'.repeat(20)): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let round = 0; round < count; round++) {
    const userSeq = round * 3 + 1;
    history.push({ seq: userSeq, id: `u${round}`, ts: 't', from: 'user', type: 'user', content: `第 ${round + 1} 轮 ${text}` });
    history.push({ seq: userSeq + 1, id: `a${round}`, ts: 't', from: 'claude', type: 'reply', replyTo: userSeq, content: text });
    history.push({ seq: userSeq + 2, id: `b${round}`, ts: 't', from: 'chatgpt', type: round === 1 ? 'failure' : 'reply', replyTo: userSeq, content: text });
  }
  return history;
}
const temp = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const directory = await mkdtemp(join(tmpdir(), 'jixia-compact-'));
  // A group may still be writing when its test ends; retry instead of failing on a file that just appeared.
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return directory;
};
const until = async (condition: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5000;
  while (!(await condition())) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('a round ends where the next user message begins; the round in progress has no end yet', () => {
  const history = rounds(3);
  assert.deepEqual(roundEnds({ history, activeUserSeq: null }), [3, 6, 9]);
  assert.deepEqual(roundEnds({ history, activeUserSeq: 7 }), [3, 6]);
  assert.deepEqual(roundEnds({ history: history.slice(0, 7), activeUserSeq: 7 }), [3, 6]);
  assert.deepEqual(roundEnds({ history: [], activeUserSeq: null }), []);
});

test('nothing is compressed below the threshold or while only the kept rounds exist', () => {
  const none = { coveredThroughSeq: 0, body: '' };
  assert.equal(planCompact({ history: rounds(6), activeUserSeq: null }, none, { ...settings, thresholdTokens: 100_000 }, TEMPLATE), null);
  assert.equal(planCompact({ history: rounds(3), activeUserSeq: null }, none, settings, TEMPLATE), null);
  // Four rounds on disk, but the fourth is still running: only three are finished.
  assert.equal(planCompact({ history: rounds(4), activeUserSeq: 10 }, none, settings, TEMPLATE), null);
});

test('the plan covers everything after the old summary up to the fourth-last finished round', () => {
  const history = rounds(6);
  const first = planCompact({ history, activeUserSeq: null }, { coveredThroughSeq: 0, body: '' }, settings, TEMPLATE)!;
  assert.equal(first.through, 9);
  assert(first.prompt.includes('最多 500 字符') && first.prompt.includes('# 新增原文（seq 1 到 9）'));
  assert(first.prompt.includes('"seq":9') && !first.prompt.includes('"seq":10'));
  // A failed answer is part of its round, without the error text.
  assert(first.prompt.includes('{"seq":6,"from":"chatgpt","failed":true}'));

  const later = planCompact({ history: rounds(8), activeUserSeq: 22 }, { coveredThroughSeq: 9, body: BODY }, settings, TEMPLATE)!;
  assert.equal(later.through, 12); // Rounds 5, 6, 7 are kept; round 8 is in progress.
  assert(later.prompt.includes('# 旧摘要（覆盖到 seq 9）') && later.prompt.includes('端口 43128'));
  assert(later.prompt.includes('"seq":10') && !later.prompt.includes('"seq":9,') && !later.prompt.includes('"seq":13'));
  assert.equal(planCompact({ history: rounds(6), activeUserSeq: null }, { coveredThroughSeq: 9, body: BODY }, settings, TEMPLATE), null);
});

test('when everything does not fit one call, the plan takes fewer rounds; one round that cannot fit is an error', () => {
  const history = rounds(8, '长'.repeat(300));
  const plan = planCompact({ history, activeUserSeq: null }, { coveredThroughSeq: 0, body: '' }, { ...settings, maxPromptTokens: 2200 }, TEMPLATE)!;
  assert.equal(plan.through, 6);
  assert.throws(() => planCompact({ history, activeUserSeq: null }, { coveredThroughSeq: 0, body: '' }, { ...settings, maxPromptTokens: 500 }, TEMPLATE), /超过了上下文预算/);
});

test('a summary must keep the five sections in order and stay within its size', () => {
  assert.equal(checkSummaryBody(`\n${BODY}\n`, 500), BODY);
  assert.equal(checkSummaryBody(BODY.replace('每个 bot 各自', '每个bot各自'), 500).includes('每个bot各自'), true);
  assert.throws(() => checkSummaryBody('  ', 500), /空摘要/);
  assert.throws(() => checkSummaryBody(BODY.replace('## 4. 任务分配', '## 4. 其他'), 500), /任务分配/);
  assert.throws(() => checkSummaryBody(BODY, 20), /摘要过长/);
  assert.throws(() => checkSummaryBody(undefined, 500), /空摘要/);
});

test('a summary that does not line up with the history is refused', () => {
  const history = rounds(3);
  checkSummary({ coveredThroughSeq: 0, body: '' }, history);
  checkSummary({ coveredThroughSeq: 6, body: BODY }, history);
  checkSummary({ coveredThroughSeq: 9, body: BODY }, history);
  assert.throws(() => checkSummary({ coveredThroughSeq: 6, body: '' }, history), /正文是空的/);
  assert.throws(() => checkSummary({ coveredThroughSeq: 12, body: BODY }, history), /只到 seq 9/);
  assert.throws(() => checkSummary({ coveredThroughSeq: 5, body: BODY }, history), /不在一轮的末尾/);
});

test('a misaligned summary file fails the round and says which file to fix', async t => {
  const directory = await temp(t);
  await writeFile(join(directory, 'system.md'), '你是 {{self}}');
  await writeFile(join(directory, 'summary.md'), `---\ncoveredThroughSeq: 5\n---\n${BODY}`);
  const prepare = createPreparer({
    systemPath: join(directory, 'system.md'), commonPath: join(directory, 'common.md'), selfPath: bot => join(directory, `${bot}.md`),
    summaryPath: join(directory, 'summary.md'), recordsPath: join(directory, 'records.jsonl'), bots: ['claude'], defaultWriter: 'claude',
  });
  const history = rounds(3).slice(0, 7);
  await assert.rejects(prepare({ message: { id: 'u2', content: history[6].content, targets: ['claude'] }, history }), /不在一轮的末尾.*summary\.md/);
});

test('compaction replaces the summary in one step, runs one at a time, and keeps the old file on failure', async t => {
  const directory = await temp(t);
  const summaryPath = join(directory, 'summary.md'), templatePath = join(directory, 'compact.md');
  await writeFile(templatePath, TEMPLATE);
  const prompts: string[] = [];
  let answer: () => Promise<string> = async () => BODY;
  const compact = createCompactor({ summaryPath, templatePath, settings, run: prompt => { prompts.push(prompt); return answer(); } });
  let history = rounds(6);
  const snapshot = () => ({ history, activeUserSeq: null });

  // Two triggers at once share one run.
  assert.deepEqual(await Promise.all([compact(snapshot), compact(snapshot)]), [1, 1]);
  assert.equal(prompts.length, 1);
  assert.deepEqual(parseSummary(await readFile(summaryPath, 'utf8')), { coveredThroughSeq: 9, body: BODY });
  assert.equal(await compact(snapshot), 0);

  history = rounds(7);
  for (const bad of [async () => '没有结构的一段话', async () => { throw new Error('CLI 超时'); }]) {
    answer = bad;
    await assert.rejects(compact(snapshot));
    assert.equal(parseSummary(await readFile(summaryPath, 'utf8')).coveredThroughSeq, 9);
  }
  // The retry starts from the old summary again.
  answer = async () => BODY;
  assert.equal(await compact(snapshot), 1);
  assert(prompts.at(-1)!.includes('# 旧摘要（覆盖到 seq 9）') && prompts.at(-1)!.includes('# 新增原文（seq 10 到 12）'));
  assert.equal(parseSummary(await readFile(summaryPath, 'utf8')).coveredThroughSeq, 12);
});

test('a backlog too big for one call is worked off in several', async t => {
  const directory = await temp(t);
  await writeFile(join(directory, 'compact.md'), TEMPLATE);
  let calls = 0;
  const compact = createCompactor({ summaryPath: join(directory, 'summary.md'), templatePath: join(directory, 'compact.md'), settings: { ...settings, maxPromptTokens: 2200 }, run: async () => { calls++; return BODY; } });
  const history = rounds(8, '长'.repeat(300));
  assert.equal(await compact(() => ({ history, activeUserSeq: null })), 3);
  assert.equal(calls, 3);
  assert.equal(parseSummary(await readFile(join(directory, 'summary.md'), 'utf8')).coveredThroughSeq, 15);
});

test('in a group: answers are not held up, later rounds get the summary plus only newer messages, and a failed compaction is retried', async t => {
  const root = await temp(t);
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'prompts', 'system.md'), '你是 {{self}}');
  await writeFile(join(root, 'prompts', 'compact.md'), TEMPLATE);
  const prompts: string[] = [];
  const summaries: string[] = [];
  let release: (() => void) | undefined;
  let fail = true, hold = true;
  const groups = await Groups.open({
    root, logins: {},
    config: resolveConfig({ bots: { claude: { provider: 'claude' } }, compact: { thresholdTokens: 200, keepRounds: 1, maxSummaryTokens: 150 } }),
    bots: { claude: async input => { prompts.push(input.prompt!); return '回答'.repeat(15); } },
    summarize: async prompt => {
      summaries.push(prompt);
      if (fail) throw new Error('额度用完');
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return BODY.replace('- 端口 43128（seq 1）', '- 暗号 KIWI（seq 1）').replace('- const retries = 2;', '（无）');
    },
  });
  const events: AppEvent[] = [];
  groups.subscribe(event => events.push(event));
  const { id } = await groups.create('压缩');
  const summaryPath = join(root, 'data', 'groups', id, 'summary.md');
  const send = async (messageId: string, content: string) => {
    await groups.use(id, scheduler => scheduler.enqueue({ id: messageId, content }));
    groups.kick(id);
    await until(() => groups.use(id, scheduler => scheduler.round === null && scheduler.history.some(message => message.id === messageId)), `the round for ${messageId}`);
  };

  await send('m1', '暗号是 KIWI，' + '铺垫'.repeat(40));
  await send('m2', '第二轮 ' + '铺垫'.repeat(40));
  // Two finished rounds, one kept: the first is due, and the attempt fails.
  await until(() => events.some(event => event.type === 'error'), 'the failure to be reported');
  assert.match((events.find(event => event.type === 'error') as { message: string }).message, /压缩对话失败.*额度用完/);
  await assert.rejects(readFile(summaryPath, 'utf8'), /ENOENT/);

  // The next round's end retries. The summary call hangs; the round after it must still be answered.
  fail = false;
  await send('m3', '第三轮');
  await until(() => release !== undefined, 'the retry to start');
  await send('m4', '第四轮');
  assert(prompts.at(-1)!.includes('暗号是 KIWI')); // Old state: no summary yet, all raw text.
  hold = false;
  release!();
  await until(async () => (await readFile(summaryPath, 'utf8').catch(() => '')).includes('coveredThroughSeq'), 'the summary file');
  // Planned when rounds 1-3 were finished and one round is kept: at least rounds 1 and 2 are covered.
  assert(parseSummary(await readFile(summaryPath, 'utf8')).coveredThroughSeq >= 4);

  await send('m5', '第五轮');
  const last = prompts.at(-1)!;
  assert(last.includes('暗号 KIWI（seq 1）') && !last.includes('暗号是 KIWI') && last.includes('第五轮'));
  // The journal and the readable records still hold everything.
  assert((await readFile(join(root, 'data', 'groups', id, 'records.jsonl'), 'utf8')).includes('暗号是 KIWI'));
  assert((await groups.use(id, scheduler => scheduler.history))[0].content.includes('暗号是 KIWI'));
});
