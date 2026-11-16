import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPreparer, discussionInstructions } from '../src/context.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { Bot, BotReply, ChatMessage, DiscussionStep, SchedulerEvent } from '../src/scheduler.ts';

// Automatic discussion in the scheduler. Bots are scripted; no CLI is started.

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(process.cwd(), '.scheduler-test-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  return directory;
}
const deferred = <T = void>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
type Script = (step: DiscussionStep | undefined, bot: string) => BotReply | Promise<BotReply>;
// Each bot answers by its name and the step it is in; the script can override.
function bots(names: string[], script: Script = () => ({ reply: '', moreToSay: true }), calls: string[] = []): Record<string, Bot> {
  return Object.fromEntries(names.map(name => [name, async input => {
    const label = input.step ? String(input.step.round) : 'plain';
    calls.push(`${name}@${label}`);
    const out = await script(input.step, name);
    return { ...out, reply: out.reply || `${name} 在 ${label}` };
  }]));
}
// One line per non-user record, for reading failures.
export const steps = (history: ChatMessage[]) => history.filter(m => m.type !== 'user').map(m => m.type === 'notice' ? `notice:${m.content}` : `${m.from}@${m.discussion ?? 'plain'}${m.type === 'failure' ? '(failed)' : ''}`);

test('a discussion runs its steps in parallel, then the default writer sums up; it is one round from start to finish', async t => {
  const directory = await fixture(t);
  const calls: string[] = [];
  const events: SchedulerEvent[] = [];
  const scheduler = await Scheduler.open(directory, bots(['claude', 'chatgpt'], undefined, calls), { discussion: { defaultWriter: 'claude' }, onEvent: event => events.push(event) });
  await scheduler.enqueue({ id: 'm1', content: '讨论一下', targets: ['claude', 'chatgpt'], discuss: 2 });
  await scheduler.runUntilIdle();
  const answers = scheduler.history.filter(m => m.type === 'reply');
  assert.deepEqual(answers.map(m => `${m.from}@${m.discussion}`).sort(), ['chatgpt@1', 'chatgpt@2', 'chatgpt@3', 'claude@1', 'claude@2', 'claude@3', 'claude@summary'].sort());
  assert.equal(answers.at(-1)!.discussion, 'summary');
  assert.equal(answers.at(-1)!.from, 'claude');
  // Every answer replies to the one user message: still a single round.
  assert(answers.every(m => m.replyTo === 1));
  assert.equal(scheduler.round, null);
  // The page saw each step start, with the bots still to answer.
  const rounds = events.filter(e => e.type === 'round').map(e => e.round?.step ? `${e.round.step.round}/${e.round.step.rounds}:${e.round.pending.length}` : String(e.round));
  assert(rounds.includes('1/3:2') && rounds.includes('2/3:2') && rounds.includes('3/3:2') && rounds.includes('summary/3:1') && rounds.at(-1) === 'null', rounds.join(' '));
  assert.equal(calls.length, 7);
});

test('the three stops: the cap, nobody having more to say, and a usage limit; the first answers never end it early', async t => {
  // Cap: one step after the first answers, however much they still want to say.
  {
    const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt']), { discussion: { defaultWriter: 'claude' } });
    await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 1 });
    await scheduler.runUntilIdle();
    assert.equal(scheduler.history.filter(m => m.discussion === 2).length, 2);
    assert.equal(scheduler.history.filter(m => m.discussion === 3).length, 0);
    assert(!scheduler.history.some(m => m.type === 'notice')); // Reaching the cap is not news.
  }
  // Nothing more to say after step 2: no step 3. Saying so in the first answers does not count.
  {
    const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], () => ({ reply: '', moreToSay: false })), { discussion: { defaultWriter: 'claude' } });
    await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 4 });
    await scheduler.runUntilIdle();
    assert.deepEqual([1, 2, 3].map(round => scheduler.history.filter(m => m.discussion === round).length), [2, 2, 0]);
    assert(scheduler.history.some(m => m.content === '讨论提前结束：各 bot 都表示没有新的要说'));
    assert(scheduler.history.some(m => m.discussion === 'summary'));
  }
  // One bot still has more to say: it goes on.
  {
    const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], (_step, bot) => ({ reply: '', moreToSay: bot === 'chatgpt' })), { discussion: { defaultWriter: 'claude' } });
    await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 2 });
    await scheduler.runUntilIdle();
    assert.equal(scheduler.history.filter(m => m.discussion === 3).length, 2);
  }
  // Usage limit: checked before each new step and before the summary.
  {
    const asked: string[][] = [];
    const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt']), { discussion: { defaultWriter: 'claude', canContinue: list => { asked.push(list); return 'chatgpt 的 5 小时额度已用 93%'; } } });
    await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 2 });
    await scheduler.runUntilIdle();
    assert.equal(scheduler.history.filter(m => m.discussion === 2).length, 0);
    assert(scheduler.history.some(m => m.content === '讨论提前结束：chatgpt 的 5 小时额度已用 93%'));
    assert(scheduler.history.some(m => m.content === '不写小结：chatgpt 的 5 小时额度已用 93%'));
    assert.deepEqual(asked, [['claude', 'chatgpt'], ['claude']]);
  }
});

test('stopping lets the running step finish, starts no new one, and still writes the summary', async t => {
  const gate = deferred();
  const reached = deferred();
  const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], async step => {
    if (step?.round === 2) { reached.resolve(); await gate.promise; }
    return { reply: '', moreToSay: true };
  }), { discussion: { defaultWriter: 'claude' } });
  assert.equal(scheduler.stopDiscussion(), false); // Nothing running.
  await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 3 });
  const running = scheduler.runUntilIdle();
  await reached.promise;
  assert.equal(scheduler.stopDiscussion(), true);
  assert.equal(scheduler.stopDiscussion(), false); // Already asked.
  gate.resolve();
  await running;
  assert.equal(scheduler.history.filter(m => m.discussion === 2).length, 2); // The running step finished.
  assert.equal(scheduler.history.filter(m => m.discussion === 3).length, 0);
  assert(scheduler.history.some(m => m.content === '讨论提前结束：已按你的要求停止讨论'));
  assert(scheduler.history.some(m => m.discussion === 'summary'));
  // A plain round later is not affected by the earlier stop.
  await scheduler.enqueue({ id: 'm2', content: 'y', targets: ['claude', 'chatgpt'], discuss: 1 });
  await scheduler.runUntilIdle();
  assert.equal(scheduler.history.filter(m => m.replyTo === scheduler.history.find(u => u.id === 'm2')!.seq && m.discussion === 2).length, 2);
});

test('a bot that fails drops out; with fewer than two left the discussion ends, and someone who took part sums up', async t => {
  const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], (step, bot) => {
    if (bot === 'claude' && step?.round !== 1) throw new Error('超时');
    return { reply: '', moreToSay: true };
  }), { discussion: { defaultWriter: 'claude' } });
  await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 3 });
  await scheduler.runUntilIdle();
  const history = scheduler.history;
  assert(history.some(m => m.from === 'claude' && m.discussion === 2 && m.type === 'failure'));
  assert.equal(history.filter(m => m.discussion === 3).length, 0);
  assert(history.some(m => m.content === '讨论提前结束：能继续讨论的 bot 不到两个'));
  // claude answered in step 1, so it is still the summary writer; its failure there is recorded, nothing else breaks.
  const summary = history.find(m => m.discussion === 'summary')!;
  assert.deepEqual([summary.from, summary.type], ['claude', 'failure']);
  assert.equal(scheduler.round, null);
});

test('the summary falls to a bot that took part when the default writer never answered', async t => {
  const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], (_step, bot) => {
    if (bot === 'claude') throw new Error('没有登录');
    return { reply: '', moreToSay: true };
  }), { discussion: { defaultWriter: 'claude' } });
  await scheduler.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 2 });
  await scheduler.runUntilIdle();
  assert.equal(scheduler.history.find(m => m.discussion === 'summary')!.from, 'chatgpt');
});

test('only the first answers may write memory; requests made later in a discussion are ignored', async t => {
  const applied: string[] = [];
  const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], (step, bot) => ({
    reply: '', moreToSay: true, memoryRequests: bot === 'claude' ? [{ target: 'common', op: 'append', content: `第 ${step?.round} 步` }] : [],
  })), {
    discussion: { defaultWriter: 'claude' },
    applyMemory: async ({ requests }) => { applied.push(...requests.map(r => r.content)); return requests.map(r => `写入：${r.content}`); },
  });
  await scheduler.enqueue({ id: 'm1', content: '记住这个：x', targets: ['claude', 'chatgpt'], discuss: 2 });
  await scheduler.runUntilIdle();
  assert.deepEqual(applied, ['第 1 步']);
});

test('one target means no discussion, said in the group; a message without discuss is a plain round', async t => {
  const calls: string[] = [];
  const scheduler = await Scheduler.open(await fixture(t), bots(['claude', 'chatgpt'], undefined, calls), { discussion: { defaultWriter: 'claude' } });
  await scheduler.enqueue({ id: 'm1', content: '@claude 你好', discuss: 2 });
  await scheduler.enqueue({ id: 'm2', content: '普通消息' });
  await scheduler.runUntilIdle();
  assert.deepEqual([...calls].sort(), ['chatgpt@plain', 'claude@plain', 'claude@plain']);
  assert(scheduler.history.some(m => m.content === '只有一个 bot，不讨论'));
  assert(!scheduler.history.some(m => m.discussion !== undefined));
});

test('discussion settings are checked on the way in and kept with the queued message, across a reopen', async t => {
  const directory = await fixture(t);
  const scheduler = await Scheduler.open(directory, bots(['claude', 'chatgpt']));
  for (const discuss of [0, 5, 1.5, -1]) await assert.rejects(scheduler.enqueue({ id: `bad-${discuss}`, content: 'x', discuss }), /讨论回合数只能是 1 到 4/);
  assert.equal(await scheduler.enqueue({ id: 'm1', content: 'x', discuss: 3 }), true);
  assert.equal(await scheduler.enqueue({ id: 'm1', content: 'x', discuss: 3 }), false); // Same message again.
  await assert.rejects(scheduler.enqueue({ id: 'm1', content: 'x', discuss: 2 }), /reused/);
  await assert.rejects(scheduler.enqueue({ id: 'm1', content: 'x' }), /reused/);
  assert.equal((await Scheduler.open(directory, bots(['claude', 'chatgpt']))).queue[0].discuss, 3);
});

test('a restart in the middle of a discussion closes it like any interrupted round: no summary, no retry', async t => {
  const directory = await fixture(t);
  const reached = deferred();
  const first = await Scheduler.open(directory, bots(['claude', 'chatgpt'], async step => {
    if (step?.round === 2) { reached.resolve(); await new Promise(() => {}); }
    return { reply: '', moreToSay: true };
  }), { discussion: { defaultWriter: 'claude' } });
  await first.enqueue({ id: 'm1', content: 'x', targets: ['claude', 'chatgpt'], discuss: 2 });
  void first.runUntilIdle();
  await reached.promise;
  const reopened = await Scheduler.open(directory, bots(['claude', 'chatgpt']), { discussion: { defaultWriter: 'claude' } });
  assert.equal(reopened.round, null);
  const step2 = reopened.history.filter(m => m.discussion === undefined && m.type === 'failure');
  assert.deepEqual(step2.map(m => m.content), ['回答中断：应用已重启', '回答中断：应用已重启']);
  assert(!reopened.history.some(m => m.discussion === 'summary'));
});

test('a discussion step gets the discussion instructions, sees the earlier steps, and may not write memory', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'system.md'), '你是 {{self}}');
  const template = '# 讨论回合\n第 {{round}}/{{rounds}} 回合，回应别人。\n\n# 小结\n写小结。\n';
  await writeFile(join(directory, 'discussion.md'), template);
  const prompts: Record<string, string[]> = { claude: [], chatgpt: [] };
  const prepare = createPreparer({
    systemPath: join(directory, 'system.md'), commonPath: join(directory, 'common.md'), selfPath: bot => join(directory, `${bot}.md`),
    summaryPath: join(directory, 'summary.md'), recordsPath: 'records', bots: ['claude', 'chatgpt'], defaultWriter: 'claude', discussionPath: join(directory, 'discussion.md'),
  });
  const scheduler = await Scheduler.open(join(directory, 'group'), { claude: async input => { prompts.claude.push(input.prompt!); return { reply: `claude 答 ${input.step?.round}`, moreToSay: true }; }, chatgpt: async input => { prompts.chatgpt.push(input.prompt!); return { reply: `chatgpt 答 ${input.step?.round}`, moreToSay: true }; } }, { prepare, discussion: { defaultWriter: 'claude' } });
  await scheduler.enqueue({ id: 'm1', content: '要不要用 SQLite？', targets: ['claude', 'chatgpt'], discuss: 1 });
  await scheduler.runUntilIdle();
  const [first, second, summary] = prompts.claude;
  // The first answers are a plain prompt: no discussion section, and this round's writer named.
  assert(!first.includes('# 自动讨论') && first.includes('本轮可以写公共记忆的 bot：claude'));
  // Step 2: the instructions with the step filled in, the user's message as the current one, and both first answers in the record.
  assert(second.includes('# 自动讨论\n第 2/2 回合，回应别人。') && !second.includes('写小结。'));
  assert(second.includes('本轮可以写公共记忆的 bot：无（讨论回合不写记忆）'));
  assert(second.includes('"from":"claude","discussion":1,"content":"claude 答 1"') && second.includes('"from":"chatgpt","discussion":1,"content":"chatgpt 答 1"'));
  assert.match(second.split('# 当前用户消息')[1], /要不要用 SQLite？/);
  // The summary: its own instructions, and the step 2 answers in the record.
  assert(summary.includes('# 自动讨论\n写小结。') && summary.includes('"discussion":2,"content":"chatgpt 答 2"'));
  assert.equal(discussionInstructions(template, { round: 3, rounds: 4 }), '第 3/4 回合，回应别人。');
  assert.throws(() => discussionInstructions('# 讨论回合\n只有这一节', { round: 2, rounds: 2 }), /缺少“# 小结”/);
  // The template file is the real one in prompts/ for the app; it has both parts.
  const real = await readFile(join(process.cwd(), 'prompts', 'discussion.md'), 'utf8');
  assert.match(discussionInstructions(real, { round: 2, rounds: 3 }), /第 2 回合（共最多 3 回合）/);
  assert.match(discussionInstructions(real, { round: 'summary', rounds: 3 }), /负责写小结/);
});

