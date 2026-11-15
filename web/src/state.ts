// All client state and how server data changes it. No DOM or React in here,
// so the rules can be tested in Node (tests/web-state.test.ts).

export type ChatMessage = { seq: number; id: string; ts: string; from: string; type: 'user' | 'reply' | 'failure' | 'notice'; replyTo?: number; content: string; model?: string; effort?: string };
export type PendingMessage = { id: string; content: string; targets: string[] };
export type RoundState = { messageId: string; userSeq: number; pending: string[] };
export type GroupInfo = { id: string; name: string; createdAt: string };
export type ModelInfo = { id: string; name: string; efforts: string[] };
export type ModelList = { models: ModelInfo[]; defaultEfforts: string[]; note?: string };
export type BotStatus = { name: string; provider: string; enabled: boolean; login: { kind: string; detail: string }; models: ModelList };
/** What each bot is asked to use in a group. A missing field means the CLI decides. */
export type Choice = { model?: string; effort?: string };
export type Selection = Record<string, Choice>;

export type ServerEvent =
  | { group: string; type: 'message'; message: ChatMessage }
  | { group: string; type: 'queue'; queue: PendingMessage[] }
  | { group: string; type: 'round'; round: RoundState | null }
  | { group: string; type: 'selection'; selection: Selection }
  | { group: string; type: 'error'; message: string }
  | { type: 'groups'; groups: GroupInfo[] };

export type GroupState = {
  /** False until the first snapshot arrives; pushed events may come before it. */
  loaded: boolean;
  records: ChatMessage[];
  hasMore: boolean;
  queue: PendingMessage[];
  round: RoundState | null;
  error: string | null;
  // How many queue / round events have been applied. A snapshot fetched before
  // a later event must not overwrite what that event said.
  queueEvents: number;
  roundEvents: number;
  selection: Selection;
  selectionEvents: number;
};

export type State = {
  connected: boolean;
  groups: GroupInfo[];
  bots: BotStatus[];
  activeId: string | null;
  byId: Record<string, GroupState>;
  unread: Record<string, true>;
};

export type Snapshot = { records: ChatMessage[]; hasMore: boolean; queue: PendingMessage[]; round: RoundState | null; selection?: Selection };
export type Action =
  | { type: 'connection'; connected: boolean }
  | { type: 'groups'; groups: GroupInfo[] }
  | { type: 'bots'; bots: BotStatus[] }
  | { type: 'select'; id: string | null }
  /** `seen` is counters(state, id) taken when the request was sent. */
  | { type: 'snapshot'; id: string; snapshot: Snapshot; seen: { queueEvents: number; roundEvents: number; selectionEvents: number } }
  | { type: 'older'; id: string; records: ChatMessage[]; hasMore: boolean }
  | { type: 'event'; event: ServerEvent };

export const initialState: State = { connected: false, groups: [], bots: [], activeId: null, byId: {}, unread: {} };
const emptyGroup: GroupState = { loaded: false, records: [], hasMore: false, queue: [], round: null, error: null, queueEvents: 0, roundEvents: 0, selection: {}, selectionEvents: 0 };

export const groupState = (state: State, id: string): GroupState => state.byId[id] ?? emptyGroup;
export const counters = (state: State, id: string) => { const group = groupState(state, id); return { queueEvents: group.queueEvents, roundEvents: group.roundEvents, selectionEvents: group.selectionEvents }; };

/** Union by seq, in seq order. The same message can arrive by push and by fetch. */
export function mergeRecords(a: readonly ChatMessage[], b: readonly ChatMessage[]): ChatMessage[] {
  const bySeq = new Map<number, ChatMessage>();
  for (const message of a) bySeq.set(message.seq, message);
  for (const message of b) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

const withGroup = (state: State, id: string, change: (group: GroupState) => GroupState): State =>
  ({ ...state, byId: { ...state.byId, [id]: change(groupState(state, id)) } });

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connection': return { ...state, connected: action.connected };
    case 'bots': return { ...state, bots: action.bots };
    case 'groups': {
      // Keep the current group if it still exists; otherwise open the newest one.
      const stillThere = action.groups.some(group => group.id === state.activeId);
      return { ...state, groups: action.groups, activeId: stillThere ? state.activeId : action.groups.at(-1)?.id ?? null };
    }
    case 'select': {
      const unread = { ...state.unread };
      if (action.id) delete unread[action.id];
      return { ...state, activeId: action.id, unread };
    }
    case 'snapshot': return withGroup(state, action.id, group => ({
      ...group,
      loaded: true,
      // After a reconnect the snapshot is only the tail; keep older pages already loaded.
      records: mergeRecords(group.records, action.snapshot.records),
      hasMore: group.loaded ? group.hasMore : action.snapshot.hasMore,
      queue: group.queueEvents === action.seen.queueEvents ? action.snapshot.queue : group.queue,
      round: group.roundEvents === action.seen.roundEvents ? action.snapshot.round : group.round,
      selection: group.selectionEvents === action.seen.selectionEvents && action.snapshot.selection ? action.snapshot.selection : group.selection,
      error: null,
    }));
    case 'older': return withGroup(state, action.id, group => ({ ...group, records: mergeRecords(action.records, group.records), hasMore: action.hasMore }));
    case 'event': {
      const event = action.event;
      if (event.type === 'groups') return reducer(state, { type: 'groups', groups: event.groups });
      const id = event.group;
      switch (event.type) {
        case 'message': {
          const next = withGroup(state, id, group => ({ ...group, records: mergeRecords(group.records, [event.message]) }));
          // Your own message is not news to you; an answer in another group is.
          return id === state.activeId || event.message.type === 'user' ? next : { ...next, unread: { ...next.unread, [id]: true } };
        }
        case 'queue': return withGroup(state, id, group => ({ ...group, queue: event.queue, queueEvents: group.queueEvents + 1 }));
        case 'round': return withGroup(state, id, group => ({ ...group, round: event.round, roundEvents: group.roundEvents + 1 }));
        case 'selection': return withGroup(state, id, group => ({ ...group, selection: event.selection, selectionEvents: group.selectionEvents + 1 }));
        case 'error': return withGroup(state, id, group => ({ ...group, error: event.message }));
      }
    }
  }
}

/** Editing a queued message: its text goes back into the input box, after whatever is already being typed. */
export function appendToDraft(draft: string, restored: string): string {
  if (!draft.trim()) return restored;
  return `${draft.replace(/\s+$/, '')}\n${restored}`;
}

/** Effort levels to offer for a bot: those of the chosen model, or the default model's when none is chosen. */
export function effortsFor(list: ModelList, model: string | undefined): string[] {
  if (model === undefined) return list.defaultEfforts;
  // A model that is no longer listed keeps working with whatever it was given; offer nothing new.
  return list.models.find(entry => entry.id === model)?.efforts ?? [];
}

/** The choice after picking a model: an effort the new model does not accept goes back to the default. */
export function withModel(list: ModelList, current: Choice, model: string | undefined): Choice {
  const keep = current.effort !== undefined && effortsFor(list, model).includes(current.effort);
  return { ...(model === undefined ? {} : { model }), ...(keep ? { effort: current.effort } : {}) };
}
