import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from './api.ts';
import { ageText, appendToDraft, estimateTokens, isDirty, loadLatest, memoryArrived, memoryLabel, completeMention, counters, defaultLabels, effortsFor, groupState, initialState, mentionAt, mentionOptions, quotaLevel, reducer, resetText } from './state.ts';
import type { BotStatus, ChatMessage, Choice, ChoiceChange, GroupState, MemoryEntry, MemoryFile, PendingMessage, QuotaState, Selection, ServerEvent, State, Switches } from './state.ts';

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
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [view, setView] = useState<'chat' | 'memory'>('chat');
  const memoryDirty = useRef(false);
  const markMemoryDirty = useCallback((dirty: boolean) => { memoryDirty.current = dirty; }, []);
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
          const [{ groups }, { bots }, { quotas }] = await Promise.all([api.groups(), api.status(), api.quota()]);
          dispatch({ type: 'groups', groups });
          dispatch({ type: 'bots', bots });
          dispatch({ type: 'quotas', quotas });
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
  // Leaving the memory page with unsaved edits asks first.
  const leaveMemory = () => {
    if (view === 'memory' && memoryDirty.current && !window.confirm('记忆有未保存的修改，离开会丢掉这些修改。确定离开吗？')) return false;
    setView('chat');
    return true;
  };
  return (
    <div className="app">
      <Sidebar state={state} memoryOpen={view === 'memory'} onMemory={() => { if (view === 'memory') leaveMemory(); else setView('memory'); }}
        onSelect={id => { if (leaveMemory()) dispatch({ type: 'select', id }); }} onCreate={async name => {
        if (!leaveMemory()) return false;
        try { const { group } = await api.createGroup(name); dispatch({ type: 'select', id: group.id }); return true; }
        catch (error) { toast(errorText(error)); return false; }
      }} refreshing={refreshingQuota} onRefreshQuota={async () => {
        setRefreshingQuota(true);
        // The new values also arrive by push; applying the reply covers a dropped connection.
        try { dispatch({ type: 'quotas', quotas: (await api.refreshQuota()).quotas }); }
        catch (error) { toast(errorText(error)); }
        finally { setRefreshingQuota(false); }
      }} />
      <main className="chat">
        {!state.connected && <div className="banner" role="status">和后端的连接断开了，正在重连…</div>}
        {view === 'memory'
          ? <MemoryPage changes={state.memoryChanges} toast={toast} onClose={leaveMemory} onDirtyChange={markMemoryDirty} />
          : active
          ? <Chat key={active.id} id={active.id} name={active.name} group={groupState(state, active.id)} bots={state.bots}
              draft={drafts[active.id] ?? ''} setDraft={change => setDraft(active.id, change)} toast={toast}
              onDelete={async () => {
                try {
                  // The count comes from the server: the page may hold only the latest records.
                  const { messageCount } = await api.snapshot(active.id);
                  if (!window.confirm(`删除群「${active.name}」？共 ${messageCount} 条消息。\n\n群文件夹会移到 data/deleted/，需要时可以手动移回来恢复。`)) return;
                  await api.deleteGroup(active.id);
                  // The group list itself updates from the backend's push.
                  setDraft(active.id, () => '');
                } catch (error) { toast(errorText(error)); }
              }}
              onOlder={(records, hasMore) => dispatch({ type: 'older', id: active.id, records, hasMore })} />
          : <div className="empty"><h2>还没有群</h2><p>在左边新建一个群，一个话题开一个群，上下文更短、更集中。</p></div>}
      </main>
      <div className="toasts" aria-live="polite">{toasts.map(item => <div key={item.id} className="toast">{item.text}</div>)}</div>
    </div>
  );
}

function Sidebar({ state, onSelect, onCreate, onRefreshQuota, refreshing, memoryOpen, onMemory }: {
  state: State; onSelect: (id: string) => void; onCreate: (name: string) => Promise<boolean>; onRefreshQuota: () => void; refreshing: boolean;
  memoryOpen: boolean; onMemory: () => void;
}) {
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
      <div className="brand-row">
        <h1 className="brand">jixia</h1>
        <button className={memoryOpen ? "memory-button active" : "memory-button"} onClick={onMemory} aria-pressed={memoryOpen} title="查看和编辑长期记忆">记忆</button>
      </div>
      <form className="new-group" onSubmit={submit}>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="新群的名字" maxLength={100} aria-label="新群的名字" />
        <button type="submit" disabled={!name.trim() || creating}>新建</button>
      </form>
      <nav className="groups" aria-label="群聊">
        {[...state.groups].reverse().map(group => (
          <button key={group.id} className={group.id === state.activeId && !memoryOpen ? 'group active' : 'group'} onClick={() => onSelect(group.id)} aria-current={group.id === state.activeId && !memoryOpen}>
            <span className="group-name">{group.name}</span>
            {groupState(state, group.id).round && <span className="working" title="正在回答" />}
            {state.unread[group.id] && <span className="unread" title="有新回答" />}
          </button>
        ))}
      </nav>
      <div className="bots">
        {Object.keys(state.quotas).length > 0 && (
          <div className="quota-head">
            <span>订阅额度（整个账号）</span>
            <button onClick={onRefreshQuota} disabled={refreshing} title="立即重新查询，平时每 5 分钟自动更新">{refreshing ? '查询中…' : '刷新'}</button>
          </div>
        )}
        <ul aria-label="bot 状态">
          {state.bots.map(bot => (
            <li key={bot.name} className={bot.enabled ? 'bot' : 'bot off'}>
              <span className="bot-line"><span className="dot" /> @{bot.name}<span className="bot-state">{bot.enabled ? '可用' : '未启用'}</span></span>
              {!bot.enabled && <span className="bot-detail">{bot.login.detail}</span>}
              {state.quotas[bot.provider] && <QuotaBars state={state.quotas[bot.provider]} />}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

// The two usage windows of one subscription. A reading kept after a failed
// read is greyed and says how old it is.
function QuotaBars({ state }: { state: QuotaState }) {
  const now = new Date();
  if (!state.quota) return <span className="bot-detail quota-missing" title={state.error}>额度查不到{state.error ? `：${state.error}` : ''}</span>;
  const stale = Boolean(state.error);
  const rows = [['5 小时', state.quota.fiveHour], ['每周', state.quota.weekly]] as const;
  return (
    <div className={stale ? 'quota stale' : 'quota'} title={stale ? `最近一次查询失败：${state.error}` : undefined}>
      {rows.map(([label, window]) => window && (
        <div key={label} className={`quota-row ${quotaLevel(window.usedPercent)}`}>
          <div className="quota-text"><span>{label} · 已用 {window.usedPercent}%</span><span>{resetText(window.resetsAt, now)}</span></div>
          <div className="quota-bar" role="progressbar" aria-label={`${label}已用`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent}>
            <span style={{ width: `${window.usedPercent}%` }} />
          </div>
        </div>
      ))}
      {stale && <div className="quota-age">{ageText(state.checkedAt, now)}的数据，最近一次查询失败</div>}
    </div>
  );
}

function Chat({ id, name, group, bots, draft, setDraft, toast, onOlder, onDelete }: {
  id: string; name: string; group: GroupState; bots: BotStatus[]; draft: string;
  setDraft: (change: (draft: string) => string) => void; toast: (text: string) => void;
  onOlder: (records: ChatMessage[], hasMore: boolean) => void; onDelete: () => void;
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
  // @ completion. The list follows the text before the caret; Esc hides it for
  // that one mention, and it stays hidden until that @ is gone.
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const usable = bots.filter(bot => bot.enabled).map(bot => bot.name);
  const mention = composing ? null : mentionAt(draft, caret);
  const options = mention && mention.start !== dismissedAt ? mentionOptions(usable, mention.query) : [];
  const listOpen = options.length > 0;
  const current = Math.min(highlighted, Math.max(0, options.length - 1));
  const trackCaret = (element: HTMLTextAreaElement) => setCaret(element.selectionStart ?? element.value.length);

  const complete = (name: string) => {
    const result = completeMention(draft, caret, name);
    setDraft(() => result.text);
    setCaret(result.caret);
    setHighlighted(0);
    // The new text is in the box only after React renders it; put the caret after the inserted name then.
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(result.caret, result.caret); });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while an IME is composing confirms the candidate; it must not send or pick.
    if (event.nativeEvent.isComposing) return;
    if (listOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((current + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); complete(options[current]); return; }
      if (event.key === 'Escape') { event.preventDefault(); setDismissedAt(mention!.start); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
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
        <button className="delete-group" onClick={onDelete} disabled={!!group.round} title={group.round ? '这个群正在回答，等这一轮结束后再删' : '删除这个群'}>删除群</button>
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
      <ModelPickers bots={bots} selection={group.selection} disabled={!group.loaded} onPick={async (bot, change) => {
        // The backend's push updates the dropdowns; a refusal leaves them as they were.
        try { await api.select(id, bot, change); } catch (error) { toast(errorText(error)); }
      }} switches={group.switches} onSwitch={async change => {
        try { await api.setSwitches(id, change); } catch (error) { toast(errorText(error)); }
      }} />
      <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        {listOpen && (
          <ul className="mentions" role="listbox" aria-label="选择要 @ 的 bot">
            {options.map((option, index) => (
              <li key={option} role="option" aria-selected={index === current} className={index === current ? 'active' : undefined}
                // mousedown, not click: a click would first take the focus away from the input box.
                onMouseDown={event => { event.preventDefault(); complete(option); }} onMouseEnter={() => setHighlighted(index)}>
                @{option}{option === 'all' && <span className="mention-note">所有 bot</span>}
              </li>
            ))}
          </ul>
        )}
        <textarea ref={input} value={draft} rows={1}
          onChange={event => {
            const element = event.target;
            setDraft(() => element.value);
            trackCaret(element);
            setHighlighted(0);
            // Once that @ is gone, a new one at the same place opens the list again.
            if (!mentionAt(element.value, element.selectionStart ?? element.value.length)) setDismissedAt(null);
          }}
          onSelect={event => trackCaret(event.currentTarget)} onKeyDown={onKeyDown}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); trackCaret(event.currentTarget); }}
          role="combobox" aria-expanded={listOpen} aria-autocomplete="list"
          placeholder={group.round ? '可以继续发，消息会排队' : '发消息，Enter 发送'} title="Enter 发送，Shift+Enter 换行，输入 @ 选择 bot" aria-label="消息" />
        <button type="submit" disabled={!draft.trim()}>发送</button>
      </form>
    </>
  );
}

// One model and one effort dropdown per usable bot. The choice belongs to the
// group and applies to every round that starts after it, queued messages included.
function ModelPickers({ bots, selection, disabled, onPick, switches, onSwitch }: {
  bots: BotStatus[]; selection: Selection; disabled: boolean; onPick: (bot: string, change: ChoiceChange) => void;
  switches: Switches | null; onSwitch: (change: Partial<Switches>) => void;
}) {
  const usable = bots.filter(bot => bot.enabled);
  if (!usable.length) return null;
  return (
    <div className="pickers" aria-label="每个 bot 用的模型">
      {usable.map(bot => {
        const choice = selection[bot.name] ?? {};
        const labels = defaultLabels(bot.models, choice);
        const efforts = effortsFor(bot.models, choice.model);
        // A saved choice that is no longer in the list stays visible instead of silently showing "默认".
        const unlisted = choice.model !== undefined && !bot.models.models.some(model => model.id === choice.model);
        const strayEffort = choice.effort !== undefined && !efforts.includes(choice.effort);
        return (
          <span key={bot.name} className="picker" title={bot.models.note}>
            <span className="picker-name">{bot.name}{bot.models.note ? ' ⚠' : ''}</span>
            <select aria-label={`${bot.name} 的模型`} disabled={disabled} value={choice.model ?? ''}
              onChange={event => onPick(bot.name, { model: event.target.value || null })}>
              <option value="">{labels.model}</option>
              {unlisted && <option value={choice.model}>{choice.model}</option>}
              {bot.models.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
            <select aria-label={`${bot.name} 的 effort`} disabled={disabled || (!efforts.length && !strayEffort)} value={choice.effort ?? ''}
              onChange={event => onPick(bot.name, { effort: event.target.value || null })}>
              <option value="">{labels.effort}</option>
              {strayEffort && <option value={choice.effort}>{choice.effort}</option>}
              {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </span>
        );
      })}
      {/* The box follows what the backend says; a click asks for the change and the push sets it. */}
      <span className="switches">
        <label title="打开后这个群的 bot 可以联网搜索和抓取网页，更费额度；仍然只读">
          <input type="checkbox" disabled={disabled || !switches} checked={switches?.webSearch ?? false} onChange={event => onSwitch({ webSearch: event.target.checked })} /> 联网搜索
        </label>
        <label title="打开后这个群的每次调用都存成 CLI 自己的会话，可以在 claude --resume、codex resume 里查看">
          <input type="checkbox" disabled={disabled || !switches} checked={switches?.keepSessions ?? false} onChange={event => onSwitch({ keepSessions: event.target.checked })} /> 保存会话
        </label>
      </span>
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

// Long-term memory files, editable. Saving is refused when the file changed
// after it was loaded (a bot wrote to it), and your text stays in the box.
function MemoryPage({ changes, toast, onClose, onDirtyChange }: {
  changes: Record<string, number>; toast: (text: string) => void; onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const [entries, setEntries] = useState<Record<string, MemoryEntry>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [current, setCurrent] = useState('common');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Loads every file; edits in progress are kept (see memoryArrived).
  const load = useCallback(async () => {
    try {
      const { files } = await api.memory();
      setOrder(files.map(file => file.name));
      setEntries(previous => Object.fromEntries(files.map(file => [file.name, memoryArrived(previous[file.name], file)])));
      setLoadError(null);
    } catch (error) { setLoadError(errorText(error)); }
  }, []);
  // On open, and whenever a file is written while the page is open.
  const changeKey = JSON.stringify(changes);
  useEffect(() => { void load(); }, [load, changeKey]);

  const dirty = Object.values(entries).some(isDirty);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  // A closed tab or reload would lose unsaved text; the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const entry = entries[current];
  const update = (change: (entry: MemoryEntry) => MemoryEntry) => setEntries(all => all[current] ? { ...all, [current]: change(all[current]) } : all);
  const save = async () => {
    if (!entry) return;
    setSaving(true);
    try {
      const { file } = await api.saveMemory(current, entry.text, entry.saved.version);
      setEntries(all => ({ ...all, [current]: { saved: file, text: all[current]?.text === entry.text ? file.content : all[current].text } }));
      toast(`${memoryLabel(current)}已保存，下一轮开始生效`);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'memory-changed') update(value => ({ ...value, latest: error.data.latest as MemoryFile }));
      else toast(errorText(error));
    } finally { setSaving(false); }
  };

  const tokens = entry ? estimateTokens(entry.text) : 0;
  return (
    <section className="memory-page" aria-label="记忆">
      <header className="chat-header">
        <h2>记忆</h2>
        <span className="status">所有群共用，bot 每一轮都会读到</span>
        <button className="memory-close" onClick={onClose}>关闭</button>
      </header>
      {loadError && <div className="banner error" role="alert">读取记忆失败：{loadError}</div>}
      <div className="memory-tabs" role="tablist">
        {order.map(name => (
          <button key={name} role="tab" aria-selected={name === current} className={name === current ? 'active' : undefined} onClick={() => setCurrent(name)}>
            {memoryLabel(name)}{entries[name] && isDirty(entries[name]) ? ' ●' : ''}
          </button>
        ))}
      </div>
      {entry?.latest && (
        <div className="banner" role="alert">
          这份记忆在你打开之后被写入了新内容（可能是 bot 写的）。为了不覆盖它，现在不能保存；你改的文字还在下面，需要的话先复制出来。
          <button onClick={() => update(loadLatest)}>载入最新内容（放弃你的修改）</button>
        </div>
      )}
      {entry && (
        <div className="memory-editor">
          <textarea value={entry.text} onChange={event => { const text = event.target.value; update(value => ({ ...value, text })); }}
            aria-label={memoryLabel(current)} spellCheck={false}
            placeholder={'还没有内容。每行一条，例如：\n[2026-11-15] 用户喝咖啡不加糖。'} />
          <div className="memory-actions">
            <span className={tokens > entry.saved.limit ? 'memory-size over' : 'memory-size'}>约 {tokens} / {entry.saved.limit} token{tokens > entry.saved.limit ? '，建议整理' : ''}</span>
            <button onClick={() => update(value => ({ ...value, text: value.saved.content }))} disabled={!isDirty(entry) || saving}>放弃修改</button>
            <button className="primary" onClick={save} disabled={!isDirty(entry) || saving || Boolean(entry.latest)}>{saving ? '保存中…' : '保存'}</button>
          </div>
          <p className="memory-hint">保存前的旧内容会备份到 data/memory/history/，每份记忆保留最近 20 份。</p>
        </div>
      )}
    </section>
  );
}
