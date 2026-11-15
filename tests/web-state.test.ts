import test from 'node:test';
import assert from 'node:assert/strict';
import { ageText, appendToDraft, completeMention, counters, defaultLabels, effortsFor, groupState, initialState, mentionAt, mentionOptions, mergeRecords, quotaLevel, reducer, resetText } from '../web/src/state.ts';
import type { Action, ChatMessage, State } from '../web/src/state.ts';

const msg = (seq: number, from = 'user', type: ChatMessage['type'] = from === 'user' ? 'user' : 'reply'): ChatMessage => ({ seq, id: `id-${seq}`, ts: '2026-11-15T00:00:00.000Z', from, type, content: `c${seq}` });
const pending = (id: string) => ({ id, content: id, targets: ['claude'] });
const run = (state: State, ...actions: Action[]) => actions.reduce(reducer, state);
const groups = [{ id: 'a', name: '甲', createdAt: '1' }, { id: 'b', name: '乙', createdAt: '2' }];
const snapshot = (records: ChatMessage[], extra = {}) => ({ records, hasMore: false, queue: [], round: null, ...extra });

test('records merge by seq, whichever way they arrive', () => {
  assert.deepEqual(mergeRecords([msg(1), msg(3)], [msg(2), msg(3)]).map(m => m.seq), [1, 2, 3]);
  let state = run(initialState, { type: 'groups', groups }, { type: 'select', id: 'a' });
  // Pushed before the snapshot, then contained in the snapshot, then pushed again after a reconnect.
  state = run(state,
    { type: 'event', event: { group: 'a', type: 'message', message: msg(2, 'claude') } },
    { type: 'snapshot', id: 'a', snapshot: snapshot([msg(1), msg(2, 'claude')]), seen: { queueEvents: 0, roundEvents: 0, selectionEvents: 0 } },
    { type: 'event', event: { group: 'a', type: 'message', message: msg(2, 'claude') } },
    { type: 'event', event: { group: 'a', type: 'message', message: msg(3, 'chatgpt') } });
  assert.deepEqual(groupState(state, 'a').records.map(m => m.seq), [1, 2, 3]);
});

test('a snapshot that was requested before a newer push does not undo that push', () => {
  let state = run(initialState, { type: 'groups', groups }, { type: 'select', id: 'a' });
  const seen = counters(state, 'a'); // The request leaves now...
  state = run(state,
    { type: 'event', event: { group: 'a', type: 'queue', queue: [pending('m2')] } },
    { type: 'event', event: { group: 'a', type: 'round', round: { messageId: 'm1', userSeq: 1, pending: ['claude'] } } });
  // ...and its answer, describing the earlier moment, arrives after the pushes.
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: snapshot([msg(1)]), seen });
  const group = groupState(state, 'a');
  assert.deepEqual(group.queue.map(m => m.id), ['m2']);
  assert.equal(group.round?.messageId, 'm1');
  assert.equal(group.loaded, true);
  // With no push in between, the snapshot is the truth (this is what a reconnect relies on).
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: snapshot([msg(1), msg(2, 'claude')]), seen: counters(state, 'a') });
  assert.deepEqual([groupState(state, 'a').queue, groupState(state, 'a').round], [[], null]);
});

test('older pages go in front, and a reconnect snapshot keeps them', () => {
  let state = run(initialState, { type: 'groups', groups }, { type: 'select', id: 'a' },
    { type: 'snapshot', id: 'a', snapshot: snapshot([msg(5), msg(6)], { hasMore: true }), seen: { queueEvents: 0, roundEvents: 0, selectionEvents: 0 } },
    { type: 'older', id: 'a', records: [msg(3), msg(4)], hasMore: true },
    { type: 'older', id: 'a', records: [msg(1), msg(2)], hasMore: false });
  assert.deepEqual([groupState(state, 'a').records.map(m => m.seq), groupState(state, 'a').hasMore], [[1, 2, 3, 4, 5, 6], false]);
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: snapshot([msg(6), msg(7, 'claude')], { hasMore: true }), seen: counters(state, 'a') });
  assert.deepEqual([groupState(state, 'a').records.map(m => m.seq), groupState(state, 'a').hasMore], [[1, 2, 3, 4, 5, 6, 7], false]);
});

test('an answer in another group marks it unread; opening the group clears it', () => {
  let state = run(initialState, { type: 'groups', groups }, { type: 'select', id: 'a' },
    { type: 'event', event: { group: 'b', type: 'message', message: msg(1) } });
  assert.deepEqual(state.unread, {}); // Your own message, sent from another window.
  state = run(state,
    { type: 'event', event: { group: 'b', type: 'message', message: msg(2, 'claude') } },
    { type: 'event', event: { group: 'a', type: 'message', message: msg(2, 'claude') } });
  assert.deepEqual(state.unread, { b: true });
  state = reducer(state, { type: 'select', id: 'b' });
  assert.deepEqual(state.unread, {});
  assert.deepEqual(groupState(state, 'b').records.map(m => m.seq), [1, 2]);
});

test('the group list opens the newest group at first and keeps your place afterwards', () => {
  let state = reducer(initialState, { type: 'groups', groups });
  assert.equal(state.activeId, 'b');
  state = run(state, { type: 'select', id: 'a' }, { type: 'event', event: { type: 'groups', groups: [...groups, { id: 'c', name: '丙', createdAt: '3' }] } });
  assert.equal(state.activeId, 'a');
  assert.equal(reducer(initialState, { type: 'groups', groups: [] }).activeId, null);
});

test('a group error is shown until the next successful snapshot', () => {
  let state = run(initialState, { type: 'groups', groups }, { type: 'event', event: { group: 'a', type: 'error', message: '处理队列时出错' } });
  assert.equal(groupState(state, 'a').error, '处理队列时出错');
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: snapshot([]), seen: counters(state, 'a') });
  assert.equal(groupState(state, 'a').error, null);
});

test('text restored from the queue is appended to the draft, never replacing it', () => {
  assert.equal(appendToDraft('', '排队的原文'), '排队的原文');
  assert.equal(appendToDraft('  \n', '排队的原文'), '排队的原文');
  assert.equal(appendToDraft('正在写的草稿  ', '排队的原文'), '正在写的草稿\n排队的原文');
});

test('effort choices follow the chosen model', () => {
  const list = { models: [{ id: 'big', name: 'Big', efforts: ['low', 'high', 'ultra'] }, { id: 'small', name: 'Small', efforts: ['low'] }, { id: 'plain', name: 'Plain', efforts: [] }], defaultEfforts: ['low', 'high'] };
  assert.deepEqual(effortsFor(list, undefined), ['low', 'high']);
  assert.deepEqual(effortsFor(list, 'big'), ['low', 'high', 'ultra']);
  assert.deepEqual(effortsFor(list, 'gone'), []);
});

test('the model choice comes with the snapshot, follows pushes, and a stale snapshot does not undo a push', () => {
  let state = reducer(initialState, { type: 'snapshot', id: 'a', snapshot: { ...snapshot([]), selection: { claude: { model: 'sonnet' } } }, seen: counters(initialState, 'a') });
  assert.deepEqual(groupState(state, 'a').selection, { claude: { model: 'sonnet' } });
  const seen = counters(state, 'a'); // A request leaves now...
  state = reducer(state, { type: 'event', event: { group: 'a', type: 'selection', selection: { claude: { model: 'opus', effort: 'high' } } } });
  // ...and comes back with what was true before the change.
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: { ...snapshot([]), selection: { claude: { model: 'sonnet' } } }, seen });
  assert.deepEqual(groupState(state, 'a').selection, { claude: { model: 'opus', effort: 'high' } });
  assert.deepEqual(groupState(state, 'b').selection, {});
});

test('the "no choice" entries name the CLI default when it is known', () => {
  const codex = { models: [{ id: 'sol', name: 'Sol', efforts: ['low', 'high'], defaultEffort: 'low' }, { id: 'luna', name: 'Luna', efforts: ['low', 'medium'], defaultEffort: 'medium' }, { id: 'old', name: 'Old', efforts: ['low'] }], defaultEfforts: ['low', 'high'], defaultModel: { id: 'sol', name: 'Sol' }, defaultEffort: 'low' };
  assert.deepEqual(defaultLabels(codex, {}), { model: '默认（Sol）', effort: '默认（low）' });
  // The effort default follows the chosen model.
  assert.deepEqual(defaultLabels(codex, { model: 'luna' }), { model: '默认（Sol）', effort: '默认（medium）' });
  assert.deepEqual(defaultLabels(codex, { model: 'old' }), { model: '默认（Sol）', effort: '默认 effort' });
  // Claude Code names its default model but not its default effort; with no list there is nothing to name.
  assert.deepEqual(defaultLabels({ models: [], defaultEfforts: [], defaultModel: { id: 'claude-opus-5-5', name: 'Opus 5.5' } }, {}), { model: '默认（Opus 5.5）', effort: '默认 effort' });
  assert.deepEqual(defaultLabels({ models: [], defaultEfforts: [] }, {}), { model: '默认模型', effort: '默认 effort' });
});

test('an @ mention is found only at a word start, before the caret', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' });
  assert.deepEqual(mentionAt('你好 @cl', 6), { start: 3, query: 'cl' });
  assert.deepEqual(mentionAt('你好@cl', 5), { start: 2, query: 'cl' }); // Chinese right before @ still counts, as in routing.
  assert.deepEqual(mentionAt('＠ch', 3), { start: 0, query: 'ch' });
  assert.equal(mentionAt('a@b.com', 2), null); // An e-mail address is not a mention.
  assert.equal(mentionAt('@claude 你好', 10), null); // The caret has moved past the mention.
  assert.deepEqual(mentionAt('@claude 你好', 3), { start: 0, query: 'cl' });
  assert.deepEqual(mentionOptions(['claude', 'chatgpt'], ''), ['claude', 'chatgpt', 'all']);
  assert.deepEqual(mentionOptions(['claude', 'chatgpt'], 'C'), ['claude', 'chatgpt']);
  assert.deepEqual(mentionOptions(['claude', 'chatgpt'], 'cha'), ['chatgpt']);
  assert.deepEqual(mentionOptions(['claude', 'chatgpt'], 'x'), []);
});

test('completing a mention writes the full name and one space, and puts the caret after it', () => {
  assert.deepEqual(completeMention('@cl', 3, 'claude'), { text: '@claude ', caret: 8 });
  assert.deepEqual(completeMention('你看 @ch 怎么样', 6, 'chatgpt'), { text: '你看 @chatgpt 怎么样', caret: 12 });
  // Letters after the caret are part of the same word and are replaced, not doubled.
  assert.deepEqual(completeMention('@clau', 2, 'claude'), { text: '@claude ', caret: 8 });
  assert.deepEqual(completeMention('没有提到', 2, 'claude'), { text: '没有提到', caret: 2 });
});

test('quota readings come with the lists and follow pushes; bars change colour at 70% and 90%', () => {
  const reading = { claude: { quota: { fiveHour: { usedPercent: 34 }, weekly: { usedPercent: 15 } }, checkedAt: '2026-11-15T12:00:00.000Z' } };
  let state = reducer(initialState, { type: 'quotas', quotas: reading });
  assert.deepEqual(state.quotas, reading);
  state = reducer(state, { type: 'event', event: { type: 'quota', quotas: { ...reading, codex: { error: '查询超时' } } } });
  assert.equal(state.quotas.codex.error, '查询超时');
  assert.deepEqual([0, 69, 70, 89, 90, 100].map(quotaLevel), ['ok', 'ok', 'warn', 'warn', 'danger', 'danger']);
});

test('reset times show the time today and the date otherwise; old readings say how old', () => {
  const now = new Date(2026, 10, 15, 13, 0);
  assert.equal(resetText(new Date(2026, 10, 15, 17, 59).toISOString(), now), '17:59 重置');
  assert.equal(resetText(new Date(2026, 10, 21, 4, 59).toISOString(), now), '11/21 04:59 重置');
  assert.equal(resetText(undefined, now), '');
  assert.equal(ageText(new Date(2026, 10, 15, 12, 59, 50).toISOString(), now), '刚才');
  assert.equal(ageText(new Date(2026, 10, 15, 12, 48).toISOString(), now), '12 分钟前');
  assert.equal(ageText(new Date(2026, 10, 15, 10, 30).toISOString(), now), '2 小时前');
});

test('a reconnect that missed more than one page drops the older records instead of leaving a gap', () => {
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
  let state = reducer(initialState, { type: 'snapshot', id: 'a', snapshot: snapshot(range(1, 5)), seen: counters(initialState, 'a') });
  // Disconnected while 250 more records were written; the reconnect brings the newest 200.
  state = reducer(state, { type: 'snapshot', id: 'a', snapshot: snapshot(range(56, 255), { hasMore: true }), seen: counters(state, 'a') });
  assert.deepEqual([groupState(state, 'a').records[0].seq, groupState(state, 'a').records.at(-1)!.seq, groupState(state, 'a').records.length, groupState(state, 'a').hasMore], [56, 255, 200, true]);
  // "加载更早的记录" asks for what comes before seq 56 and the list is whole again.
  state = reducer(state, { type: 'older', id: 'a', records: range(1, 55), hasMore: false });
  assert.deepEqual(groupState(state, 'a').records.map(m => m.seq), range(1, 255).map(m => m.seq));
  // A record pushed while the snapshot was on its way is kept when it lies above the snapshot.
  let racing = reducer(initialState, { type: 'snapshot', id: 'b', snapshot: snapshot(range(1, 5)), seen: counters(initialState, 'b') });
  const seen = counters(racing, 'b');
  racing = reducer(racing, { type: 'event', event: { group: 'b', type: 'message', message: msg(256) } });
  racing = reducer(racing, { type: 'snapshot', id: 'b', snapshot: snapshot(range(56, 255), { hasMore: true }), seen });
  assert.deepEqual([groupState(racing, 'b').records[0].seq, groupState(racing, 'b').records.at(-1)!.seq, groupState(racing, 'b').records.length], [56, 256, 201]);
});
