import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { GroupBusyError, GroupNotFoundError } from './groups.ts';
import { MemoryChangedError } from './memory.ts';
import type { QuotaMonitor } from './quota.ts';
import { GroupRetiredError, MessageTooLongError, NotQueuedError } from './scheduler.ts';
import type { Groups } from './groups.ts';

// Local HTTP + WebSocket front for the browser. The browser sends commands
// over HTTP; everything that changes is pushed over the one WebSocket.

class HttpError extends Error {
  status: number;
  constructor(status: number, text: string) { super(text); this.status = status; }
}

// The server only listens on the loopback interface, but a web page on any
// site can still make the browser call it. Accept a request only when both
// the address it was sent to and the page it came from are this machine.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocal = (value: string | undefined, kind: 'host' | 'origin') => {
  if (value === undefined) return kind === 'origin'; // Non-browser clients send no Origin.
  try { return LOCAL_HOSTS.has(new URL(kind === 'host' ? `http://${value}` : value).hostname); } catch { return false; }
};
const allowed = (request: IncomingMessage) => isLocal(request.headers.host, 'host') && isLocal(request.headers.origin, 'origin');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '请求过大');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) return body;
  } catch { /* fall through */ }
  throw new HttpError(400, '请求体必须是 JSON 对象');
}

const DEFAULT_TAIL = 200;
const MAX_PAGE = 500;
const pageSize = (value: string | null) => {
  if (value === null) return DEFAULT_TAIL;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'limit 必须是正整数');
  return Math.min(size, MAX_PAGE);
};

export type RunningServer = { port: number; close: () => Promise<void> };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// The built web page. Anything that is not a file falls back to index.html.
async function serveStatic(staticDir: string | undefined, pathname: string, response: ServerResponse): Promise<void> {
  const plain = (status: number, text: string) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); response.end(text); };
  if (!staticDir) return plain(404, 'jixia 后端正在运行，但没有配置网页目录。');
  const base = resolve(staticDir);
  let relative: string;
  try { relative = decodeURIComponent(pathname); } catch { return plain(400, '地址格式不对'); }
  let file = resolve(base, '.' + relative);
  // A request may only ever reach files inside the build folder.
  if (file !== base && !file.startsWith(base + sep)) return plain(403, '不允许访问');
  let content: Buffer | undefined;
  if (file !== base) content = await readFile(file).catch(() => undefined);
  if (!content) { file = join(base, 'index.html'); content = await readFile(file).catch(() => undefined); }
  if (!content) return plain(404, '网页还没有构建。先运行 npm run build，再刷新这个页面。');
  // Vite puts a content hash in asset file names, so those can be cached for good.
  const cache = relative.startsWith('/assets/') && !file.endsWith('index.html') ? 'public, max-age=31536000, immutable' : 'no-cache';
  response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': content.length, 'cache-control': cache });
  response.end(content);
}

export async function startServer(options: { groups: Groups; port: number; staticDir?: string; quota?: QuotaMonitor }): Promise<RunningServer> {
  const { groups } = options;

  async function route(request: IncomingMessage, url: URL): Promise<{ status?: number; body: unknown }> {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method ?? 'GET';
    const is = (verb: string, ...shape: (string | null)[]) => method === verb && parts.length === shape.length && shape.every((part, index) => part === null || part === parts[index]);

    if (is('GET', 'api', 'status')) return { body: { bots: groups.bots } };
    // Usage of each subscription, keyed by provider. Empty when no monitor runs.
    if (is('GET', 'api', 'memory')) return { body: { files: await groups.memory.list() } };
    if (is('PUT', 'api', 'memory', null)) {
      const body = await readJson(request);
      if (typeof body.content !== 'string' || typeof body.baseVersion !== 'string') throw new HttpError(400, '需要 content 和 baseVersion');
      return { body: { file: await groups.memory.save(parts[2], body.content, body.baseVersion) } };
    }
    if (is('GET', 'api', 'quota'))return { body: { quotas: options.quota?.get() ?? {} } };
    if (is('POST', 'api', 'quota', 'refresh')) { await options.quota?.refresh(); return { body: { quotas: options.quota?.get() ?? {} } }; }
    if (is('GET', 'api', 'groups')) return { body: { groups: groups.list() } };
    if (is('POST', 'api', 'groups')) return { status: 201, body: { group: await groups.create((await readJson(request)).name) } };

    const id = parts[2];
    if (is('GET', 'api', 'groups', null)) {
      const group = groups.info(id);
      return { body: await groups.use(id, scheduler => {
        const history = scheduler.history;
        const records = history.slice(-pageSize(url.searchParams.get('limit')));
        return { group, records, hasMore: records.length < history.length, messageCount: history.length, queue: scheduler.queue, round: scheduler.round, selection: groups.selection(id), switches: groups.switches(id) };
      }) };
    }
    if (is('DELETE', 'api', 'groups', null)) {
      return { body: { group: await groups.remove(id) } };
    }
    if (is('PUT', 'api', 'groups', null, 'switches')) {
      const body = await readJson(request);
      const change = Object.fromEntries((['webSearch', 'keepSessions'] as const).filter(key => key in body).map(key => [key, body[key]]));
      return { body: { switches: await groups.setSwitches(id, change) } };
    }
    if (is('PUT', 'api', 'groups', null, 'models', null)) {
      const body = await readJson(request);
      // Only the fields sent are changed; see Groups.select.
      const change = Object.fromEntries((['model', 'effort'] as const).filter(key => key in body).map(key => [key, body[key]]));
      return { body: { selection: await groups.select(id, parts[4], change) } };
    }
    if (is('GET', 'api', 'groups', null, 'records')) {
      const before = Number(url.searchParams.get('before'));
      if (!Number.isInteger(before) || before < 1) throw new HttpError(400, 'before 必须是正整数');
      const limit = pageSize(url.searchParams.get('limit'));
      return { body: await groups.use(id, scheduler => {
        const older = scheduler.history.filter(message => message.seq < before);
        const records = older.slice(-limit);
        return { records, hasMore: records.length < older.length };
      }) };
    }
    if (is('POST', 'api', 'groups', null, 'messages')) {
      const body = await readJson(request);
      if (typeof body.id !== 'string' || !body.id || body.id.length > 100 || typeof body.content !== 'string' || !body.content.trim()) throw new HttpError(400, '消息需要 id 和非空的 content');
      // Routing reads the @ mentions; the client never chooses targets directly.
      const queued = await groups.use(id, scheduler => scheduler.enqueue({ id: body.id as string, content: body.content as string }));
      groups.kick(id);
      return { status: 202, body: { queued } };
    }
    if (is('DELETE', 'api', 'groups', null, 'queue', null)) {
      // Used for both delete and edit: the caller gets the accepted text back.
      return { body: { message: await groups.use(id, scheduler => scheduler.remove(parts[4])) } };
    }
    if (is('POST', 'api', 'groups', null, 'queue', null, 'top')) {
      await groups.use(id, scheduler => scheduler.moveToTop(parts[4]));
      return { body: { queue: await groups.use(id, scheduler => scheduler.queue) } };
    }
    throw new HttpError(404, '没有这个接口');
  }

  const failure = (error: unknown): { status: number; body: { error: string; code: string; latest?: unknown } } => {
    if (error instanceof HttpError) return { status: error.status, body: { error: error.message, code: 'bad-request' } };
    if (error instanceof GroupNotFoundError || error instanceof GroupRetiredError) return { status: 404, body: { error: '群不存在', code: 'group-not-found' } };
    // The current file comes back with the refusal, so the page can show it without asking again.
    if (error instanceof MemoryChangedError) return { status: 409, body: { error: error.message, code: 'memory-changed', latest: error.latest } };
    if (error instanceof GroupBusyError)return { status: 409, body: { error: error.message, code: 'group-busy' } };
    if (error instanceof MessageTooLongError) return { status: 413, body: { error: error.message, code: 'message-too-long' } };
    if (error instanceof NotQueuedError) return { status: 409, body: { error: '消息已开始处理', code: 'not-queued' } };
    if (error instanceof RangeError) return { status: 400, body: { error: error.message, code: 'bad-request' } };
    if (error instanceof Error && /reused with different payload/.test(error.message)) return { status: 409, body: { error: '这个消息 id 已经用过', code: 'id-reused' } };
    if (error instanceof URIError) return { status: 400, body: { error: '地址格式不对', code: 'bad-request' } };
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error), code: 'internal' } };
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    response.end(text);
  };

  const server = createServer((request, response) => {
    if (!allowed(request)) { send(response, 403, { error: '只接受来自本机页面的请求', code: 'forbidden' }); return; }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') { send(response, 405, { error: '不支持这个方法', code: 'bad-request' }); return; }
      serveStatic(options.staticDir, url.pathname, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
      return;
    }
    route(request, url).then(result => send(response, result.status ?? 200, result.body), error => { const { status, body } = failure(error); send(response, status, body); });
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (!allowed(request) || new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request));
  });
  // No replay on connect: a client that (re)connects fetches the group over
  // HTTP, then applies whatever is pushed from here on.
  const broadcast = (event: unknown) => {
    const text = JSON.stringify(event);
    for (const client of sockets.clients) if (client.readyState === client.OPEN) client.send(text);
  };
  const unsubscribeQuota = options.quota?.subscribe(quotas => broadcast({ type: 'quota', quotas }));
  const unsubscribe = groups.subscribe(broadcast);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      unsubscribe();
      unsubscribeQuota?.();
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
