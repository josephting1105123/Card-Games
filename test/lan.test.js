import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { WsConnection, acceptKey, attachWebSocket } from '../server/ws.js';
import { RoomHub } from '../server/rooms.js';
import { S2C } from '../src/net/protocol.js';
import { DEFAULT_ROOM_CURRENCY, SOLO_CURRENCY } from '../src/core/currency.js';
import { ALPHABET, CODE_LENGTH, formatCode, generateCode, parseCode, socketUrlFor } from '../src/net/roomcode.js';
import { legalPlays } from '../src/games/doudizhu/moves.js';

test('the WebSocket accept key follows RFC 6455', () => {
  // The example from the specification.
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('room codes are five characters from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(ALPHABET.includes(ch), `${ch} is not in the alphabet`);
  }
  assert.equal(ALPHABET.includes('O'), false);
  assert.equal(ALPHABET.includes('I'), false);
  assert.equal(ALPHABET.includes('0'), false);
  assert.equal(ALPHABET.includes('1'), false);
});

test('room codes parse, with or without a host address', () => {
  assert.deepEqual(parseCode('krm7q'), { code: 'KRM7Q', host: null, port: null, valid: true });
  assert.deepEqual(parseCode(' krm 7q '), { code: 'KRM7Q', host: null, port: null, valid: true });
  assert.deepEqual(parseCode('KRM7Q@192.168.1.24'), { code: 'KRM7Q', host: '192.168.1.24', port: 8787, valid: true });
  assert.equal(parseCode('KRM7Q@192.168.1.24:9000').port, 9000);
  assert.equal(parseCode('NOPE').valid, false);
  assert.equal(formatCode('KRM7Q', '192.168.1.24'), 'KRM7Q@192.168.1.24');
  assert.equal(formatCode('KRM7Q', '192.168.1.24', 9000), 'KRM7Q@192.168.1.24:9000');
  assert.equal(formatCode('KRM7Q', null), 'KRM7Q');
});

test('socketUrlFor prefers the address in the code, else the page origin', () => {
  assert.equal(socketUrlFor({ host: '10.0.0.5', port: 8787 }, { protocol: 'http:', host: 'x' }), 'ws://10.0.0.5:8787/lan');
  assert.equal(socketUrlFor({ host: null }, { protocol: 'http:', host: '10.0.0.9:8787' }), 'ws://10.0.0.9:8787/lan');
  assert.equal(socketUrlFor({ host: null }, { protocol: 'https:', host: 'example.com' }), 'wss://example.com/lan');
});

/** A test client over Node's built-in WebSocket. */
class Client {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.inbox = [];
    this.waiters = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.waiters.find((w) => w.type === message.t);
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }

  ready() {
    return this.socket.readyState === 1 ? Promise.resolve() : once(this.socket, 'open');
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Wait for the next message of a type, checking what already arrived first. */
  next(type, timeoutMs = 4_000) {
    const buffered = this.inbox.findIndex((m) => m.t === type);
    if (buffered >= 0) return Promise.resolve(this.inbox.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error(`timed out waiting for "${type}"`));
        }
      }, timeoutMs).unref();
    });
  }

  /** Drop anything already buffered, so next() waits for a genuinely new message. */
  drain(type) {
    this.inbox = this.inbox.filter((m) => m.t !== type);
  }

  /** Wait for a message of `type` that satisfies `predicate`, skipping earlier ones. */
  async until(type, predicate, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const message = await this.next(type, Math.max(50, deadline - Date.now()));
      if (predicate(message)) return message;
      if (Date.now() > deadline) throw new Error(`no matching "${type}" arrived`);
    }
  }

  close() {
    this.socket.close();
  }
}

async function startHost() {
  const hub = new RoomHub({ botStepMs: 5 });
  const server = createServer((req, res) => res.end('ok'));
  const sockets = attachWebSocket(server, { path: '/lan', onConnection: (conn) => hub.attach(conn) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/lan`,
    stop: () => {
      hub.close();
      sockets.close();
      server.close();
    },
  };
}

test('two clients share a room and play a hand to a settled result', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = new Client(host.url);
  await alice.ready();
  await alice.next(S2C.WELCOME);
  alice.send({ t: 'create', name: 'Alice', settings: { pot: 2_000, startingChips: 20_000, humanSeats: 2, botSkill: 'casual' } });
  const created = await alice.next(S2C.ROOM);
  assert.equal(created.room.settings.pot, 2_000);
  assert.equal(created.room.seats[0].name, 'Alice');
  assert.equal(created.room.settings.currency, DEFAULT_ROOM_CURRENCY,
    'a room the host did not price keeps score in the room default, not chips');
  const code = created.room.code;

  const bob = new Client(host.url);
  await bob.ready();
  await bob.next(S2C.WELCOME);
  bob.send({ t: 'join', code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  assert.equal(joined.room.seats[1].name, 'Bob');
  assert.equal(joined.room.seats[2].id, null, 'the third seat is left to a bot');

  // Only the host may change the settings or deal.
  bob.send({ t: 'settings', settings: { pot: 999_999 } });
  assert.match((await bob.next(S2C.ERROR)).message, /host/);
  bob.send({ t: 'start' });
  assert.match((await bob.next(S2C.ERROR)).message, /host/);

  alice.send({ t: 'start' });
  const firstView = await alice.next(S2C.VIEW);
  assert.equal(firstView.view.you.hand.length, 17);
  assert.equal(firstView.view.players.length, 3);
  // A seat view must not carry anyone else's cards.
  assert.equal(JSON.stringify(firstView.view).match(/"hand"/g).length, 1);

  const players = { 0: alice, 1: bob };
  const views = { 0: firstView.view, 1: (await bob.next(S2C.VIEW)).view };
  const listen = (seat) => {
    players[seat].socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.t === S2C.VIEW) views[seat] = message.view;
    });
  };
  listen(0);
  listen(1);

  // Drive both human seats with whatever the rules allow, simplest move first.
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the hand never finished')), 20_000);
    for (const seat of [0, 1]) {
      players[seat].socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.t === S2C.RESULT && seat === 0) {
          clearTimeout(timer);
          resolve(message);
        }
      });
    }
    const tick = setInterval(() => {
      for (const seat of [0, 1]) {
        const view = views[seat];
        if (!view) continue;
        if (view.phase === 'bidding' && view.bidding.turn === seat) {
          players[seat].send({ t: 'bid', value: view.bidding.highest < 3 ? view.bidding.highest + 1 : 0 });
        } else if (view.phase === 'playing' && view.turn === seat) {
          const moves = legalPlays(view.you.hand, view.trick?.combo ?? null);
          if (moves.length) players[seat].send({ t: 'play', cards: moves[0].cards.map((c) => c.id) });
          else players[seat].send({ t: 'pass' });
        }
      }
      if (views[0]?.phase === 'finished') clearInterval(tick);
    }, 25);
    timer.unref?.();
  });

  assert.ok(result.rows.length === 3);
  const total = result.rows.reduce((sum, row) => sum + row.delta, 0);
  assert.equal(total, 0, 'chips only move between seats, none are created');
  for (const row of result.rows) assert.ok(row.chips >= 0, 'nobody is left owing chips');
  assert.equal(result.rows.filter((r) => r.won).length, result.result.landlordWon ? 1 : 2);
  alice.close();
  bob.close();
});

test('a bad room code is refused and the table is not disturbed', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());
  const client = new Client(host.url);
  await client.ready();
  await client.next(S2C.WELCOME);
  client.send({ t: 'join', code: 'ZZZZZ', name: 'Nobody' });
  assert.match((await client.next(S2C.ERROR)).message, /no room/);
  client.send({ t: 'nonsense' });
  assert.match((await client.next(S2C.ERROR)).message, /unknown message/);
  client.close();
});

test('a capped hand still conserves chips in a room', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  // A big pot against small stacks guarantees the loss caps bite.
  const hub = new RoomHub({ botStepMs: 1 });
  const room = {
    code: 'TEST1',
    hostId: 'h',
    settings: { pot: 50_000, startingChips: 25_000, baseMultiplier: 2, capFactor: 6, botSkill: 'casual', humanSeats: 1 },
    members: new Map(),
    seats: [null, null, null],
    chips: new Map([['a', 25_000], ['b', 25_000], ['c', 25_000]]),
    phase: 'playing',
    state: {
      players: [{ id: 'a', name: 'A', isBot: false }, { id: 'b', name: 'B', isBot: false }, { id: 'c', name: 'C', isBot: false }],
      result: { landlordWon: true, landlordSeat: 0, multiplier: 6, bombs: 1, bidValue: 3, spring: false, antiSpring: false },
    },
  };
  hub.rooms.set(room.code, room);
  const sent = [];
  room.members.set('a', { id: 'a', name: 'A', seat: 0, connected: true, conn: { send: (text) => sent.push(JSON.parse(text)), sendJson: (v) => sent.push(v) } });

  hub.settle(room);
  hub.close();

  const settlement = sent.find((m) => m.t === S2C.RESULT);
  assert.ok(settlement, 'a result was broadcast');
  const capped = settlement.rows.filter((row) => row.capped);
  assert.ok(capped.length > 0, 'the caps should have bitten at this pot');
  assert.equal(settlement.rows.reduce((sum, row) => sum + row.delta, 0), 0,
    'a capped hand must not mint chips for the winner');
  const startingTotal = 75_000;
  assert.equal(settlement.rows.reduce((sum, row) => sum + row.chips, 0), startingTotal,
    'the chips in the room are the same before and after');
});

test('a room carries the host\'s chosen currency to everyone in it', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = new Client(host.url);
  await alice.ready();
  await alice.next(S2C.WELCOME);
  alice.send({ t: 'create', name: 'Alice', settings: { currency: 'points', pot: 5, startingChips: 100, humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);
  assert.equal(created.room.settings.currency, 'points');
  assert.equal(created.room.settings.pot, 5, 'a small pot is allowed for real-world stakes');
  assert.notEqual(created.room.settings.currency, SOLO_CURRENCY);

  const bob = new Client(host.url);
  await bob.ready();
  await bob.next(S2C.WELCOME);
  bob.send({ t: 'join', code: created.room.code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  assert.equal(joined.room.settings.currency, 'points', 'a joiner is told what the room counts in');

  bob.drain(S2C.ROOM);
  alice.send({ t: 'settings', settings: { currency: 'gbp' } });
  const changed = await bob.next(S2C.ROOM);
  assert.equal(changed.room.settings.currency, 'gbp', 'the host can change it and everyone sees it');
  alice.close();
  bob.close();
});

/** The parts of a net.Socket that WsConnection actually touches. */
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.destroyed = false;
    this.written = [];
  }

  setTimeout() {}
  setNoDelay() {}
  write(chunk, callback) { this.written.push(chunk); callback?.(null); return true; }
  end() { this.destroyed = true; this.writable = false; }
}

test('a client that vanishes does not take the host down with it', () => {
  const socket = new FakeSocket();
  const conn = new WsConnection(socket);
  let closed = false;
  conn.on('close', () => { closed = true; });

  // An EventEmitter with no 'error' listener rethrows, and a reset socket is an
  // everyday event: a phone sleeping, Wi-Fi dropping, a tab being killed.
  assert.doesNotThrow(() => {
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  });
  assert.equal(conn.open, false, 'the connection is closed out');
  assert.equal(closed, true, 'and its close is reported so the seat can be handled');
});

test('a reset client frees its seat and the room plays on', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = new Client(host.url);
  await alice.ready();
  await alice.next(S2C.WELCOME);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);

  const bob = new Client(host.url);
  await bob.ready();
  await bob.next(S2C.WELCOME);
  bob.send({ t: 'join', code: created.room.code, name: 'Bob' });
  await bob.next(S2C.ROOM);
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');

  bob.close();
  const after = await alice.until(S2C.ROOM, (m) => m.room.seats[1].id === null);
  assert.equal(after.room.seats[1].id, null, "Bob's seat is free again");

  // The host is still healthy enough to deal.
  alice.send({ t: 'start' });
  const view = await alice.next(S2C.VIEW);
  assert.equal(view.view.you.hand.length, 17);
  alice.close();
});
