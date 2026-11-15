import test from 'node:test';
import assert from 'node:assert/strict';
import { appendToDraft, counters, groupState, initialState, mergeRecords, reducer } from '../web/src/state.ts';
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
    { type: 'snapshot', id: 'a', snapshot: snapshot([msg(1), msg(2, 'claude')]), seen: { queueEvents: 0, roundEvents: 0 } },
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
    { type: 'snapshot', id: 'a', snapshot: snapshot([msg(5), msg(6)], { hasMore: true }), seen: { queueEvents: 0, roundEvents: 0 } },
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
