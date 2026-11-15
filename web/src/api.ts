import type { BotStatus, ChatMessage, Choice, GroupInfo, PendingMessage, MemoryFile, Quotas, Selection, Snapshot } from './state.ts';

/** A refusal from the backend. `code` is stable; `message` is ready to show. */
export class ApiError extends Error {
  code: string;
  /** The whole refusal, for codes that carry more than a message (memory-changed carries the latest file). */
  data: Record<string, unknown>;
  constructor(code: string, message: string, data: Record<string, unknown> = {}) { super(message); this.code = code; this.data = data; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('offline', '连不上 jixia 后端，请确认它还在运行');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.code ?? 'internal', data.error ?? `请求失败（${response.status}）`, data);
  return data as T;
}

const group = (id: string) => `/api/groups/${encodeURIComponent(id)}`;
export const api = {
  status: () => call<{ bots: BotStatus[] }>('GET', '/api/status'),
  groups: () => call<{ groups: GroupInfo[] }>('GET', '/api/groups'),
  memory: () => call<{ files: MemoryFile[] }>('GET', '/api/memory'),
  saveMemory: (name: string, content: string, baseVersion: string) => call<{ file: MemoryFile }>('PUT', `/api/memory/${encodeURIComponent(name)}`, { content, baseVersion }),
  quota: () => call<{ quotas: Quotas }>('GET', '/api/quota'),
  refreshQuota: () => call<{ quotas: Quotas }>('POST', '/api/quota/refresh'),
  createGroup: (name: string) => call<{ group: GroupInfo }>('POST', '/api/groups', { name }),
  snapshot: (id: string) => call<Snapshot & { group: GroupInfo; messageCount: number }>('GET', group(id)),
  deleteGroup: (id: string) => call<{ group: GroupInfo }>('DELETE', group(id)),
  older: (id: string, before: number) => call<{ records: ChatMessage[]; hasMore: boolean }>('GET', `${group(id)}/records?before=${before}&limit=200`),
  send: (id: string, messageId: string, content: string) => call<{ queued: boolean }>('POST', `${group(id)}/messages`, { id: messageId, content }),
  remove: (id: string, messageId: string) => call<{ message: PendingMessage }>('DELETE', `${group(id)}/queue/${encodeURIComponent(messageId)}`),
  select: (id: string, bot: string, choice: Choice) => call<{ selection: Selection }>('PUT', `${group(id)}/models/${encodeURIComponent(bot)}`, { model: choice.model ?? null, effort: choice.effort ?? null }),
  moveToTop: (id: string, messageId: string) => call<{ queue: PendingMessage[] }>('POST', `${group(id)}/queue/${encodeURIComponent(messageId)}/top`),
};
