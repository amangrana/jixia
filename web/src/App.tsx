import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from './api.ts';
import { appendToDraft, counters, effortsFor, groupState, initialState, reducer, withModel } from './state.ts';
import type { BotStatus, ChatMessage, Choice, GroupState, PendingMessage, Selection, ServerEvent, State } from './state.ts';

// Unsent text per group. Kept in this browser so a reload does not lose it.
const DRAFTS_KEY = 'jixia.drafts';
function loadDrafts(): Record<string, string> {
  try { const value = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}'); return typeof value === 'object' && value ? value : {}; } catch { return {}; }
}
function saveDrafts(drafts: Record<string, string>): void {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(Object.entries(drafts).filter(([, text]) => text)))); } catch { /* private window: drafts just do not persist */ }
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const clock = (ts: string) => { const date = new Date(ts); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); };

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const [drafts, setDrafts] = useState(loadDrafts);
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const nextToast = useRef(0);

  const toast = useCallback((text: string) => {
    const id = nextToast.current++;
    setToasts(current => [...current, { id, text }]);
    setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 6000);
  }, []);

  const setDraft = useCallback((groupId: string, change: (draft: string) => string) => {
    setDrafts(current => { const next = { ...current, [groupId]: change(current[groupId] ?? '') }; saveDrafts(next); return next; });
  }, []);

  const loadGroup = useCallback(async (id: string) => {
    const seen = counters(stateRef.current, id);
    try { dispatch({ type: 'snapshot', id, snapshot: await api.snapshot(id), seen }); }
    catch (error) { toast(errorText(error)); }
  }, [toast]);

  // One WebSocket for everything. Nothing is replayed on connect, so every
  // (re)connect fetches the lists and the open group again.
  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false, attempt = 0;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket.onopen = async () => {
        attempt = 0;
        dispatch({ type: 'connection', connected: true });
        try {
          const [{ groups }, { bots }] = await Promise.all([api.groups(), api.status()]);
          dispatch({ type: 'groups', groups });
          dispatch({ type: 'bots', bots });
        } catch (error) { toast(errorText(error)); }
        const open = stateRef.current.activeId;
        if (open) void loadGroup(open);
      };
      socket.onmessage = message => {
        try { dispatch({ type: 'event', event: JSON.parse(message.data) as ServerEvent }); } catch { /* not ours */ }
      };
      socket.onclose = () => {
        dispatch({ type: 'connection', connected: false });
        if (!stopped) retry = setTimeout(connect, Math.min(5000, 500 * 2 ** attempt++));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(retry); socket?.close(); };
  }, [loadGroup, toast]);

  const activeId = state.activeId;
  useEffect(() => { if (activeId && state.connected) void loadGroup(activeId); }, [activeId, state.connected, loadGroup]);

  const active = state.groups.find(group => group.id === activeId);
  return (
    <div className="app">
      <Sidebar state={state} onSelect={id => dispatch({ type: 'select', id })} onCreate={async name => {
        try { const { group } = await api.createGroup(name); dispatch({ type: 'select', id: group.id }); return true; }
        catch (error) { toast(errorText(error)); return false; }
      }} />
      <main className="chat">
        {!state.connected && <div className="banner" role="status">和后端的连接断开了，正在重连…</div>}
        {active
          ? <Chat key={active.id} id={active.id} name={active.name} group={groupState(state, active.id)} bots={state.bots}
              draft={drafts[active.id] ?? ''} setDraft={change => setDraft(active.id, change)} toast={toast}
              onOlder={(records, hasMore) => dispatch({ type: 'older', id: active.id, records, hasMore })} />
          : <div className="empty"><h2>还没有群</h2><p>在左边新建一个群，一个话题开一个群，上下文更短、更集中。</p></div>}
      </main>
      <div className="toasts" aria-live="polite">{toasts.map(item => <div key={item.id} className="toast">{item.text}</div>)}</div>
    </div>
  );
}

function Sidebar({ state, onSelect, onCreate }: { state: State; onSelect: (id: string) => void; onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    if (await onCreate(name.trim())) setName('');
    setCreating(false);
  };
  return (
    <aside className="sidebar">
      <h1 className="brand">jixia</h1>
      <form className="new-group" onSubmit={submit}>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="新群的名字" maxLength={100} aria-label="新群的名字" />
        <button type="submit" disabled={!name.trim() || creating}>新建</button>
      </form>
      <nav className="groups" aria-label="群聊">
        {[...state.groups].reverse().map(group => (
          <button key={group.id} className={group.id === state.activeId ? 'group active' : 'group'} onClick={() => onSelect(group.id)} aria-current={group.id === state.activeId}>
            <span className="group-name">{group.name}</span>
            {groupState(state, group.id).round && <span className="working" title="正在回答" />}
            {state.unread[group.id] && <span className="unread" title="有新回答" />}
          </button>
        ))}
      </nav>
      <ul className="bots" aria-label="bot 状态">
        {state.bots.map(bot => (
          <li key={bot.name} className={bot.enabled ? 'bot' : 'bot off'}>
            <span className="bot-line"><span className="dot" /> @{bot.name}<span className="bot-state">{bot.enabled ? '可用' : '未启用'}</span></span>
            {!bot.enabled && <span className="bot-detail">{bot.login.detail}</span>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Chat({ id, name, group, bots, draft, setDraft, toast, onOlder }: {
  id: string; name: string; group: GroupState; bots: BotStatus[]; draft: string;
  setDraft: (change: (draft: string) => string) => void; toast: (text: string) => void;
  onOlder: (records: ChatMessage[], hasMore: boolean) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const botIndex = (botName: string) => Math.max(0, bots.findIndex(bot => bot.name === botName));

  // Stay at the bottom while new messages arrive, unless the user scrolled up to read.
  const last = group.records.at(-1)?.seq ?? 0;
  const pendingCount = group.round?.pending.length ?? 0;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
    // The queue panel takes room from the message list, so its size matters too.
  }, [last, pendingCount, group.loaded, group.queue.length]);

  // The list also changes height when the window, the queue panel or the input box does.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (stick.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { input.current?.focus(); }, [id]);
  // Grow the input with its content, up to a limit set in CSS.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = 'auto';
    // scrollHeight leaves out the border; without it a scrollbar appears on one line.
    const wanted = element.scrollHeight + element.offsetHeight - element.clientHeight;
    element.style.height = `${wanted}px`;
    // Scroll only once the text is taller than the CSS max-height allows.
    element.style.overflowY = wanted > element.offsetHeight + 1 ? 'auto' : 'hidden';
  }, [draft]);

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    // Clear the box now, not when the request returns: by then the user may
    // already be typing the next message, and that must not be wiped.
    setDraft(() => '');
    stick.current = true;
    try {
      await api.send(id, crypto.randomUUID(), content);
    } catch (error) {
      // Nothing was queued, so the text goes back, ahead of anything typed since.
      setDraft(current => current.trim() ? `${content}\n${current}` : content);
      toast(errorText(error));
    } finally { input.current?.focus(); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing confirms the candidate; it must not send.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };

  const queueAction = async (action: () => Promise<unknown>) => {
    try { await action(); }
    catch (error) { toast(error instanceof ApiError && error.code === 'not-queued' ? '消息已开始处理，不能再修改' : errorText(error)); }
  };
  const edit = (message: PendingMessage) => queueAction(async () => {
    // Only after the backend confirms the removal does the text come back.
    const removed = await api.remove(id, message.id);
    setDraft(current => appendToDraft(current, removed.message.content));
    input.current?.focus();
  });

  const older = async () => {
    const first = group.records[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    const element = scroller.current;
    const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;
    try {
      const page = await api.older(id, first.seq);
      stick.current = false;
      onOlder(page.records, page.hasMore);
      // Keep the message the user was looking at in place.
      requestAnimationFrame(() => { if (element) element.scrollTop = element.scrollHeight - fromBottom; });
    } catch (error) { toast(errorText(error)); }
    finally { setLoadingOlder(false); }
  };

  const enabled = bots.filter(bot => bot.enabled).map(bot => `@${bot.name}`);
  return (
    <>
      <header className="chat-header">
        <h2>{name}</h2>
        {group.round && <span className="status">正在回答 · 还差 {group.round.pending.length} 个</span>}
      </header>
      {group.error && <div className="banner error" role="alert">{group.error}</div>}
      <div className="messages" ref={scroller} onScroll={event => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {group.hasMore && <button className="older" onClick={older} disabled={loadingOlder}>{loadingOlder ? '加载中…' : '加载更早的记录'}</button>}
        {group.loaded && !group.records.length && !group.queue.length && (
          <div className="empty"><p>发一条消息开始。不 @ 时所有 bot 都回答；{enabled.length ? `写 ${enabled.join(' 或 ')} 只让一个 bot 回答。` : '目前没有可用的 bot。'}</p></div>
        )}
        {group.records.map(message => <Message key={message.seq} message={message} botIndex={botIndex(message.from)} />)}
        {group.round?.pending.map(bot => (
          <div key={bot} className={`row bot tone-${botIndex(bot) % 4}`}>
            <div className="who">{bot}</div>
            <div className="bubble typing" aria-label={`${bot} 正在回答`}><span /><span /><span /></div>
          </div>
        ))}
      </div>
      {group.queue.length > 0 && (
        <section className="queue" aria-label="排队中的消息">
          <div className="queue-title">排队中 · {group.queue.length} 条，当前这轮结束后按顺序处理</div>
          <ol>
            {group.queue.map((message, index) => (
              <li key={message.id}>
                <span className="queue-text">{message.content}</span>
                <span className="queue-actions">
                  <button onClick={() => queueAction(() => api.moveToTop(id, message.id))} disabled={index === 0} title="当前这轮结束后先处理这条">移到队首</button>
                  <button onClick={() => edit(message)} title="取回到输入框，重新发送后排到队尾">编辑</button>
                  <button className="danger" onClick={() => queueAction(() => api.remove(id, message.id))}>删除</button>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <ModelPickers bots={bots} selection={group.selection} disabled={!group.loaded} onPick={async (bot, choice) => {
        // The backend's push updates the dropdowns; a refusal leaves them as they were.
        try { await api.select(id, bot, choice); } catch (error) { toast(errorText(error)); }
      }} />
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea ref={input} value={draft} onChange={event => setDraft(() => event.target.value)} onKeyDown={onKeyDown} rows={1}
          placeholder={group.round ? '可以继续发，消息会排队' : '发消息，Enter 发送'} title="Enter 发送，Shift+Enter 换行" aria-label="消息" />
        <button type="submit" disabled={!draft.trim()}>发送</button>
      </form>
    </>
  );
}

// One model and one effort dropdown per usable bot. The choice belongs to the
// group and applies to every round that starts after it, queued messages included.
function ModelPickers({ bots, selection, disabled, onPick }: { bots: BotStatus[]; selection: Selection; disabled: boolean; onPick: (bot: string, choice: Choice) => void }) {
  const usable = bots.filter(bot => bot.enabled);
  if (!usable.length) return null;
  return (
    <div className="pickers" aria-label="每个 bot 用的模型">
      {usable.map(bot => {
        const choice = selection[bot.name] ?? {};
        const efforts = effortsFor(bot.models, choice.model);
        // A saved choice that is no longer in the list stays visible instead of silently showing "默认".
        const unlisted = choice.model !== undefined && !bot.models.models.some(model => model.id === choice.model);
        const strayEffort = choice.effort !== undefined && !efforts.includes(choice.effort);
        return (
          <span key={bot.name} className="picker" title={bot.models.note}>
            <span className="picker-name">{bot.name}{bot.models.note ? ' ⚠' : ''}</span>
            <select aria-label={`${bot.name} 的模型`} disabled={disabled} value={choice.model ?? ''}
              onChange={event => onPick(bot.name, withModel(bot.models, choice, event.target.value || undefined))}>
              <option value="">默认模型</option>
              {unlisted && <option value={choice.model}>{choice.model}</option>}
              {bot.models.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            <select aria-label={`${bot.name} 的 effort`} disabled={disabled || (!efforts.length && !strayEffort)} value={choice.effort ?? ''}
              onChange={event => onPick(bot.name, { ...(choice.model === undefined ? {} : { model: choice.model }), ...(event.target.value ? { effort: event.target.value } : {}) })}>
              <option value="">默认 effort</option>
              {strayEffort && <option value={choice.effort}>{choice.effort}</option>}
              {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </span>
        );
      })}
    </div>
  );
}

function Message({ message, botIndex }: { message: ChatMessage; botIndex: number }) {
  if (message.type === 'notice') return <div className="notice">{message.content}</div>;
  if (message.type === 'user') return (
    <div className="row user">
      <div className="bubble">{message.content}</div>
      <div className="meta">{clock(message.ts)}</div>
    </div>
  );
  return (
    <div className={`row bot tone-${botIndex % 4}`}>
      <div className="who">
        {message.from}
        {message.model && <span className="meta model" title="回答这条消息的模型">{message.model}{message.effort ? ` · ${message.effort}` : ''}</span>}
        <span className="meta">{clock(message.ts)}</span>
      </div>
      {message.type === 'failure'
        ? <div className="bubble failed"><strong>回答失败</strong>{message.content}</div>
        : <div className="bubble markdown"><Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown></div>}
    </div>
  );
}
