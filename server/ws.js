/**
 * A minimal RFC 6455 WebSocket server, written against node:http and node:crypto
 * so the LAN host needs nothing but Node: no npm install, no lockfile, nothing to
 * audit. It implements exactly what this app uses — text frames, ping/pong,
 * close, and continuation frames — and rejects anything else.
 *
 * Deliberately not implemented: permessage-deflate, binary frames, and
 * fragmenting outgoing messages. Payloads here are small JSON objects.
 */

import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
/** Refuse anything larger rather than buffering it. */
const MAX_MESSAGE = 1 << 20; // 1 MiB

export function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + GUID).digest('base64');
}

/**
 * One connected client.
 * Events: 'message' (string), 'close', 'error'.
 */
export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.id = randomBytes(8).toString('hex');
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = null;
    this.data = {}; // room code, seat, name: whatever the app wants to hang here

    // An EventEmitter with no 'error' listener throws, which would take the whole
    // host down the first time a phone slept mid-hand and the socket reset. A
    // dropped client is routine, so there is always a listener.
    this.on('error', () => {});

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (error) => {
      this.lastError = error;
      this.emit('error', error);
      this.destroy();
    });
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (this.readFrame()) { /* keep draining */ }
    } catch (error) {
      this.emit('error', error);
      this.close(1002, 'protocol error');
    }
  }

  /** @returns {boolean} true when a whole frame was consumed */
  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buf.length < offset + 2) return false;
      length = buf.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('frame too large');
      length = Number(big);
      offset += 8;
    }
    if (length > MAX_MESSAGE) throw new Error('frame too large');
    // A client frame must be masked; the spec says fail the connection otherwise.
    if (!masked) throw new Error('client frame was not masked');
    if (buf.length < offset + 4 + length) return false;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    this.buffer = buf.subarray(offset + length);

    switch (opcode) {
      case OP.PING:
        this.sendFrame(OP.PONG, payload);
        return true;
      case OP.PONG:
        return true;
      case OP.CLOSE:
        this.close(1000, '');
        return false;
      case OP.TEXT:
      case OP.BINARY:
        if (!fin) {
          this.fragmentOp = opcode;
          this.fragments = [payload];
          return true;
        }
        this.deliver(opcode, payload);
        return true;
      case OP.CONT: {
        if (this.fragmentOp === null) throw new Error('continuation without a start frame');
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, p) => n + p.length, 0);
        if (total > MAX_MESSAGE) throw new Error('message too large');
        if (!fin) return true;
        const joined = Buffer.concat(this.fragments);
        const op = this.fragmentOp;
        this.fragments = [];
        this.fragmentOp = null;
        this.deliver(op, joined);
        return true;
      }
      default:
        throw new Error(`unsupported opcode ${opcode}`);
    }
  }

  deliver(opcode, payload) {
    if (opcode !== OP.TEXT) return; // this app speaks JSON only
    this.emit('message', payload.toString('utf8'));
  }

  sendFrame(opcode, payload) {
    if (!this.open) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode, never masked from the server
    if (!this.socket.writable || this.socket.destroyed) {
      this.destroy();
      return;
    }
    try {
      // A write to a socket the peer has already dropped fails asynchronously,
      // so the callback matters as much as the try/catch.
      this.socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) this.destroy();
      });
    } catch {
      this.destroy();
    }
  }

  send(text) {
    this.sendFrame(OP.TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  ping() {
    this.sendFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const body = Buffer.allocUnsafe(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.sendFrame(OP.CLOSE, body);
    this.destroy();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try {
      this.socket.end();
    } catch { /* already gone */ }
    this.emit('close');
  }

  onClose() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

/**
 * Handle HTTP upgrades on `server` at `path`.
 * @param {import('node:http').Server} server
 * @param {{path?: string, onConnection: (conn: WsConnection) => void}} options
 */
export function attachWebSocket(server, { path = '/lan', onConnection }) {
  const connections = new Set();

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));

    const conn = new WsConnection(socket);
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection(conn);
  });

  // Drop connections that stop answering, so a room does not hold a dead seat.
  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (conn.open) conn.ping();
      else connections.delete(conn);
    }
  }, 25_000);
  heartbeat.unref?.();

  return {
    connections,
    close() {
      clearInterval(heartbeat);
      for (const conn of connections) conn.destroy();
      connections.clear();
    },
  };
}

export { OP };
