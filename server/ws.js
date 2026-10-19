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
/** More than this many messages inside the window closes the connection. */
const FLOOD_MAX_MESSAGES = 40;
const FLOOD_WINDOW_MS = 10_000;
/** A real message is one frame or a couple; dozens of fragments is a client wasting memory. */
const MAX_FRAGMENTS = 64;
/** RFC 6455 §5.5: control frames carry at most 125 bytes of payload. */
const MAX_CONTROL_PAYLOAD = 125;

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
    this.lastSeen = Date.now();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = null;
    this.fragmentBytes = 0;
    this.data = {}; // room code, seat, name: whatever the app wants to hang here
    this.recentMessages = []; // arrival times inside the flood window

    // An EventEmitter with no 'error' listener throws, which would take the whole
    // host down the first time a phone slept mid-hand and the socket reset. A
    // dropped client is routine, so there is always a listener.
    this.on('error', () => {});

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    // The HTTP server keeps sockets half-open after a bare FIN, so without this a
    // client that half-closes holds its per-IP slot until the heartbeat notices.
    socket.on('end', () => {
      this.destroy();
      socket.destroy?.();
    });
    socket.on('error', (error) => {
      this.lastError = error;
      this.emit('error', error);
      this.destroy();
    });
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  onData(chunk) {
    // Any inbound bytes prove the peer is alive, pongs included.
    this.lastSeen = Date.now();
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
    if (opcode >= OP.CLOSE && (length > MAX_CONTROL_PAYLOAD || !fin)) throw new Error('invalid control frame');
    // A client frame must be masked; the spec says fail the connection otherwise.
    if (!masked) throw new Error('client frame was not masked');
    if (buf.length < offset + 4 + length) return false;

    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) payload[i] = buf[offset + i] ^ mask[i & 3];
    this.buffer = buf.subarray(offset + length);

    // Every frame costs parsing work, whatever it carries, so pings, pongs and
    // unfinished fragments count against the window as much as a delivered message.
    if (!this.countFrame()) return false;

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
          this.fragmentBytes = payload.length;
          return true;
        }
        this.deliver(opcode, payload);
        return true;
      case OP.CONT: {
        if (this.fragmentOp === null) throw new Error('continuation without a start frame');
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_MESSAGE) throw new Error('message too large');
        if (this.fragments.length > MAX_FRAGMENTS) throw new Error('too many fragments');
        if (!fin) return true;
        const joined = Buffer.concat(this.fragments);
        const op = this.fragmentOp;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOp = null;
        this.deliver(op, joined);
        return true;
      }
      default:
        throw new Error(`unsupported opcode ${opcode}`);
    }
  }

  /**
   * A real client sends a handful of moves per hand; a script hammering the
   * public host should not get to cost the room hub work for every frame.
   * @returns {boolean} false when the flood limit closed the connection
   */
  countFrame() {
    const now = Date.now();
    this.recentMessages.push(now);
    while (this.recentMessages[0] <= now - FLOOD_WINDOW_MS) this.recentMessages.shift();
    if (this.recentMessages.length > FLOOD_MAX_MESSAGES) {
      this.close(1008, 'too many messages');
      return false;
    }
    return true;
  }

  deliver(opcode, payload) {
    if (!this.open) return;
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
    // end() waits for the peer's FIN; a half-dead peer never sends one, and the
    // connection has already left the heartbeat set, so tear the socket down.
    const { socket } = this;
    setTimeout(() => socket.destroy?.(), 1000).unref?.();
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
 * `verifyUpgrade(req)` runs before the 101: return true to accept, or
 * `{status, reason}` to answer with that HTTP error instead.
 * @param {{path?: string, onConnection: (conn: WsConnection, req: import('node:http').IncomingMessage) => void, heartbeatMs?: number, verifyUpgrade?: (req: import('node:http').IncomingMessage) => true | {status: number, reason: string}}} options
 */
export function attachWebSocket(server, { path = '/lan', onConnection, heartbeatMs = 15_000, verifyUpgrade }) {
  const connections = new Set();

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const verdict = verifyUpgrade ? verifyUpgrade(req) : true;
    if (verdict !== true) {
      socket.write(`HTTP/1.1 ${verdict.status} ${verdict.reason}\r\n\r\n`);
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
    onConnection(conn, req);
  });

  // A sleeping phone or a dropped Wi-Fi link never sends a FIN, so the socket
  // looks open for ever. Browsers answer pings on their own; a connection that
  // has sent nothing for two intervals is treated as gone, which the room hub
  // sees as a drop and hands the seat to a bot.
  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.open) {
        connections.delete(conn);
      } else if (Date.now() - conn.lastSeen > heartbeatMs * 2) {
        conn.destroy();
        // end() on a dead peer waits for a FIN that never comes and leaks the fd.
        conn.socket.destroy?.();
      } else {
        conn.ping();
      }
    }
  }, heartbeatMs);
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
