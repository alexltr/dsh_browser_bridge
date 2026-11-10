/**
 * 极简 WebSocket 服务端（RFC 6455），零第三方依赖。
 *
 * 只实现桥接需要的子集：握手、文本帧、分片、ping/pong、close。
 * 之所以不引 `ws`：本插件以「树外 bundle」安装，保持零运行时依赖，
 * 安装/升级都不需要联网装包。
 */
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function rejectUpgrade(socket, status, message) {
  try {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* ignore */
  }
  socket.destroy();
}

/** 一条已建立的 WebSocket 连接。 */
export class BridgeConnection {
  constructor(socket, info, options) {
    this.socket = socket;
    this.info = info;
    this.options = options;
    this.alive = true;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.fragmentSize = 0;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      if (!this.alive) {
        this.terminate('心跳超时');
        return;
      }
      this.alive = false;
      try {
        this.socket.write(frame(OP_PING, Buffer.from('ping')));
      } catch {
        this.terminate('写入失败');
      }
    }, 25_000);
    this.pingTimer.unref?.();

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => this.terminate('socket 错误'));
    socket.on('close', () => this.terminate('对端关闭'));
    socket.on('end', () => this.terminate('对端断开'));
  }

  receive(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (this.parseFrame()) {
        /* 继续解析剩余帧 */
      }
    } catch (err) {
      this.terminate(`帧解析失败：${err.message}`);
    }
  }

  parseFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return false;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return false;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(this.options.maxPayload)) throw new Error('帧过大');
      length = Number(big);
      offset = 10;
    }
    if (length > this.options.maxPayload) throw new Error('帧过大');
    if (masked) {
      if (buffer.length < offset + 4) return false;
    }
    const total = offset + (masked ? 4 : 0) + length;
    if (buffer.length < total) return false;
    const maskOffset = offset;
    const dataOffset = offset + (masked ? 4 : 0);
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) {
      payload[i] = masked ? buffer[dataOffset + i] ^ buffer[maskOffset + (i % 4)] : buffer[dataOffset + i];
    }
    this.buffer = buffer.subarray(total);

    if (opcode === OP_PING) {
      this.socket.write(frame(OP_PONG, payload));
      return true;
    }
    if (opcode === OP_PONG) {
      this.alive = true;
      return true;
    }
    if (opcode === OP_CLOSE) {
      try {
        this.socket.write(frame(OP_CLOSE, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
      this.terminate('浏览器扩展关闭了连接');
      return false;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentSize = payload.length;
        return true;
      }
      this.deliver(payload);
      return true;
    }
    if (opcode === OP_CONT) {
      if (!this.fragmentOpcode) throw new Error('意外的续帧');
      this.fragments.push(payload);
      this.fragmentSize += payload.length;
      if (this.fragmentSize > this.options.maxPayload) throw new Error('消息过大');
      if (fin) {
        const message = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentSize = 0;
        this.fragmentOpcode = 0;
        this.deliver(message);
      }
      return true;
    }
    throw new Error(`不支持的 opcode ${opcode}`);
  }

  deliver(payload) {
    this.alive = true;
    this.onMessage(payload.toString('utf8'));
  }

  sendText(text) {
    if (this.closed) return false;
    try {
      this.socket.write(frame(OP_TEXT, Buffer.from(text, 'utf8')));
      return true;
    } catch {
      this.terminate('写入失败');
      return false;
    }
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  terminate(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.onClose(reason);
  }

  close(code = 1000, reason = 'normal') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    try {
      this.socket.write(frame(OP_CLOSE, payload));
    } catch {
      /* ignore */
    }
    setTimeout(() => this.terminate('主动关闭'), 100);
  }
}

/**
 * 在既有 HTTP server 上挂载 /bridge 升级处理。
 * @param {import('node:http').Server} server
 * @param {{ authorize?: (req: import('node:http').IncomingMessage, url: URL) => {ok: boolean, reason?: string}, onConnection: (conn: BridgeConnection, req: import('node:http').IncomingMessage) => void, maxPayload?: number }} options
 */
export function attachBridgeServer(server, options) {
  const maxPayload = options.maxPayload ?? 8 * 1024 * 1024;
  const handler = (req, socket) => {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/bridge') return rejectUpgrade(socket, 404, 'Not Found');
    const key = req.headers['sec-websocket-key'];
    if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    const verdict = options.authorize?.(req, url) ?? { ok: true };
    if (!verdict.ok) return rejectUpgrade(socket, 403, 'Forbidden');
    const accept = crypto.createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const conn = new BridgeConnection(socket, { origin: req.headers.origin || '', url: url.toString(), remote: socket.remoteAddress }, { maxPayload });
    conn.onClose = (reason) => options.onClose?.(conn, reason);
    options.onConnection(conn, req);
  };
  server.on('upgrade', handler);
  return () => server.off('upgrade', handler);
}
