/**
 * 桥接核心：本地 WebSocket 服务 + 扩展会话 + RPC 请求/应答。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { attachBridgeServer } from './ws-server.js';

export const PROTOCOL = 1;
export const SERVER_VERSION = '0.2.0';
export const DEFAULT_EXTENSION_ID = 'hlfcjpadcahkpbdnhomoagoekopdmnfo';

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class Bridge {
  constructor(options = {}) {
    this.port = Number(options.port) || 51919;
    this.host = options.host || '127.0.0.1';
    this.token = String(options.token || '');
    const ids = Array.isArray(options.extensionIds) ? options.extensionIds.filter(Boolean) : [];
    this.extensionIds = ids.length ? ids.map(String) : [DEFAULT_EXTENSION_ID];
    this.logger = options.logger || console;
    this.server = null;
    this.detachUpgrade = null;
    this.sessions = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.startedAt = 0;
    this.lastError = '';
  }

  /** 启动监听。端口占用时抛出带建议的错误。 */
  async start() {
    if (this.server) return this;
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('DSH browser bridge: use ws://127.0.0.1:' + this.port + '/bridge\n');
    });
    server.on('clientError', (_err, socket) => {
      try { socket.destroy(); } catch { /* ignore */ }
    });
    this.detachUpgrade = attachBridgeServer(server, {
      authorize: (req, url) => this.authorize(req, url),
      onConnection: (conn) => this.onConnection(conn),
      onClose: (conn, reason) => this.onConnectionClosed(conn, reason),
      maxPayload: 8 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE') {
          reject(new Error(`端口 ${this.port} 已被占用：请修改插件配置 port，或在扩展「高级设置」里改成同一个端口。`));
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
    this.server = server;
    this.startedAt = Date.now();
    this.logger.log?.(`[browser-bridge] listening ws://${this.host}:${this.port}/bridge`);
    return this;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.detachUpgrade?.();
    this.detachUpgrade = null;
    for (const session of [...this.sessions]) {
      try { session.conn.close(1001, 'server stopping'); } catch { /* ignore */ }
    }
    this.sessions.clear();
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('浏览器桥已停止'));
      this.pending.delete(id);
    }
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 1_000).unref?.();
    });
  }

  /** 握手鉴权：只接受扩展来源（或本机无 Origin 的原生客户端）+ 可选令牌。 */
  authorize(req, url) {
    const origin = req.headers.origin ? String(req.headers.origin) : '';
    if (origin) {
      const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
      if (!match) return { ok: false, reason: '只接受浏览器扩展连接' };
      if (!this.extensionIds.includes(match[1])) return { ok: false, reason: `未授权的扩展 ID：${match[1]}` };
    }
    if (this.token) {
      const provided = url.searchParams.get('token') || '';
      if (!timingSafeEqual(provided, this.token)) return { ok: false, reason: '配对令牌不匹配' };
    }
    return { ok: true };
  }

  onConnection(conn) {
    const session = {
      id: crypto.randomUUID(),
      conn,
      client: null,
      hello: false,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.sessions.add(session);
    conn.onMessage = (text) => this.onMessage(session, text);
    conn.onClose = (reason) => this.onConnectionClosed(conn, reason);
    conn.sendJson({
      type: 'welcome',
      protocol: PROTOCOL,
      server: 'dsh-browser-bridge',
      version: SERVER_VERSION,
      sessionId: session.id,
    });
    this.logger.log?.(`[browser-bridge] extension connected from ${conn.info.origin || conn.info.remote}`);
  }

  onConnectionClosed(conn, reason) {
    const session = [...this.sessions].find((s) => s.conn === conn);
    if (!session) return;
    this.sessions.delete(session);
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== session.id) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error(`浏览器桥连接已断开（${reason}）`));
      this.pending.delete(id);
    }
    if (this.sessions.size === 0) {
      const normal = /浏览器扩展关闭|对端关闭|对端断开|主动关闭/.test(String(reason));
      this.lastError = normal ? '' : `扩展连接已断开：${reason}`;
      this.logger.warn?.(`[browser-bridge] extension disconnected: ${reason}`);
    }
  }

  onMessage(session, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    session.lastSeenAt = Date.now();
    switch (message.type) {
      case 'hello':
        session.client = {
          id: String(message.client?.id || session.id),
          name: String(message.client?.name || 'Chromium'),
          version: String(message.client?.version || ''),
          platform: String(message.client?.platform || ''),
        };
        session.capabilities = Array.isArray(message.capabilities) ? message.capabilities.map(String) : [];
        session.hello = true;
        this.lastError = '';
        break;
      case 'reply': {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.result ?? {});
        else entry.reject(new Error(String(message.error?.message || '扩展返回未知错误')));
        break;
      }
      case 'ping':
        session.conn.sendJson({ type: 'pong', at: Date.now() });
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  /** 最近一次完成 hello 的会话。 */
  activeSession() {
    let best = null;
    for (const session of this.sessions) {
      if (!session.hello) continue;
      if (!best || session.connectedAt >= best.connectedAt) best = session;
    }
    return best;
  }

  requireSession() {
    const session = this.activeSession();
    if (!session) {
      const reason = this.server
        ? (this.lastError ? `（${this.lastError}）` : '扩展尚未连接')
        : '浏览器桥服务未启动';
      throw new Error(
        `DSH 实时浏览器桥未连接：${reason}。请确认浏览器已安装并启用「DSH 实时浏览器桥」扩展（默认连接 127.0.0.1:${this.port}），` +
          `并在扩展弹窗中授权目标标签页。`,
      );
    }
    if (!session.conn || session.conn.closed) {
      this.sessions.delete(session);
      throw new Error('浏览器桥连接已断开，请稍后重试或重新打开扩展弹窗。');
    }
    return session;
  }

  /**
   * 向扩展发一条 RPC。
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  async request(method, params = {}, options = {}) {
    const session = this.requireSession();
    const timeoutMs = Math.max(1_000, Math.min(180_000, Number(options.timeoutMs) || 20_000));
    const id = ++this.seq;
    if (options.signal?.aborted) throw new Error('操作已取消');
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`扩展在 ${timeoutMs}ms 内没有响应 ${method}（可能页面脚本阻塞或标签页已休眠）。`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('操作已取消'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (fn) => (value) => {
        options.signal?.removeEventListener('abort', onAbort);
        fn(value);
      };
      this.pending.set(id, {
        sessionId: session.id,
        timer,
        resolve: settle(resolve),
        reject: settle(reject),
      });
      const ok = session.conn.sendJson({ type: 'request', id, method, params });
      if (!ok) {
        this.pending.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new Error('发送请求失败：浏览器桥连接已断开'));
      }
    });
  }

  status() {
    const session = this.activeSession();
    return {
      listening: Boolean(this.server),
      port: this.port,
      connected: Boolean(session),
      client: session?.client ?? null,
      clients: [...this.sessions].filter((s) => s.hello).map((s) => ({ ...s.client, connectedAt: s.connectedAt })),
      error: this.lastError,
      startedAt: this.startedAt,
    };
  }
}
