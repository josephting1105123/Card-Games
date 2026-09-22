/**
 * Browser side of local network play.
 *
 * A thin wrapper over WebSocket: JSON in, JSON out, with named handlers instead
 * of a switch at every call site. No reconnection loop — on a LAN a dropped
 * socket means the host went away or the Wi-Fi did, and quietly retrying would
 * only hide that from the player.
 */

import { C2S, decode, encode } from './protocol.js';

export class LanClient {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.id = null;
    this.hostInfo = null;
    this.queue = [];
  }

  /** @param {string} event  'open' | 'close' | 'error' | a S2C message type */
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        console.error('LAN handler failed', error);
      }
    }
  }

  /**
   * @param {string} url ws:// or wss:// endpoint
   * @param {number} [timeoutMs]
   */
  connect(url, timeoutMs = 8_000) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new Error(`could not open ${url}: ${error.message}`));
        return;
      }
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`no answer from ${url}. Is the host running and on this network?`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timer);
        for (const message of this.queue.splice(0)) socket.send(message);
        this.emit('open');
        resolve(this);
      });
      socket.addEventListener('message', (event) => {
        const message = decode(event.data);
        if (!message) return;
        if (message.t === 'welcome') {
          this.id = message.id;
          this.hostInfo = { host: message.host, port: message.port };
        }
        this.emit(message.t, message);
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        this.emit('close');
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        this.emit('error', new Error('the connection to the host failed'));
        reject(new Error(`could not reach ${url}`));
      });
    });
  }

  send(message) {
    const text = encode(message);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.queue.push(text);
  }

  createRoom(name, settings) { this.send({ t: C2S.CREATE, name, settings }); }
  joinRoom(code, name) { this.send({ t: C2S.JOIN, code, name }); }
  updateSettings(settings) { this.send({ t: C2S.SETTINGS, settings }); }
  setHumanSeats(humanSeats) { this.send({ t: C2S.SEAT_FILL, humanSeats }); }
  start() { this.send({ t: C2S.START }); }
  again() { this.send({ t: C2S.AGAIN }); }
  bid(value) { this.send({ t: C2S.BID, value }); }
  play(cards) { this.send({ t: C2S.PLAY, cards: cards.map((c) => c.id) }); }
  pass() { this.send({ t: C2S.PASS }); }

  close() {
    this.handlers.clear();
    try {
      this.socket?.close();
    } catch { /* already closed */ }
    this.socket = null;
  }
}
