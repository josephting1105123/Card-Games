import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { WsConnection, acceptKey, attachWebSocket } from '../server/ws.js';
import { RoomHub } from '../server/rooms.js';
import { gameAdapter } from '../server/games.js';
import { BIG2_MIN_STACK, C2S, S2C, potForStack } from '../src/net/protocol.js';
import { DEFAULT_ROOM_CURRENCY, SOLO_CURRENCY } from '../src/core/currency.js';
import { ALPHABET, CODE_LENGTH, formatCode, generateCode, parseCode, socketUrlFor } from '../src/net/roomcode.js';
import { legalPlays } from '../src/games/doudizhu/moves.js';
import { legalPlays as bigTwoPlays } from '../src/games/big2/moves.js';

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
    this.log = []; // every frame received, in order, whether or not anything waited for it
    this.waiters = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      this.log.push(message);
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
  const hub = new RoomHub({ botStepMs: 5, dealGraceMs: 0 });
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
  const hub = new RoomHub({ botStepMs: 1, dealGraceMs: 0 });
  const room = {
    code: 'TEST1',
    adapter: gameAdapter('doudizhu'),
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

/** A finished Dou Di Zhu room hand, settled straight through the adapter. */
function settleRoomHand({ pot, multiplier, landlordWon, stacks }) {
  const players = ['a', 'b', 'c'].map((id) => ({ id, name: id.toUpperCase(), isBot: false }));
  const room = {
    settings: { pot, startingChips: 250, baseMultiplier: 2, capFactor: 100 },
    chips: new Map(players.map((p, i) => [p.id, stacks[i]])),
    state: { players, result: { landlordWon, landlordSeat: 0, multiplier } },
  };
  const { frame } = gameAdapter('doudizhu').settle(room);
  return frame.rows.map((row) => row.delta);
}

test('a room settles zero-sum when the hand ceiling holds the winner down', () => {
  // pot 10 at x64: the landlord may claim 1,000 (the ceiling), the farmers owe 640 each.
  const landlordWins = settleRoomHand({ pot: 10, multiplier: 64, landlordWon: true, stacks: [5_000, 5_000, 5_000] });
  assert.deepEqual(landlordWins, [1_000, -500, -500]);

  // A landlord with a small stack can only pay what the loss cap allows (75 of 100).
  const farmersWin = settleRoomHand({ pot: 10, multiplier: 8, landlordWon: false, stacks: [100, 1_000, 1_000] });
  assert.equal(farmersWin[0], -75);
  assert.equal(farmersWin.reduce((sum, d) => sum + d, 0), 0, 'what the landlord pays is what the farmers split');

  // Odd totals still come out exact.
  const odd = settleRoomHand({ pot: 7, multiplier: 64, landlordWon: true, stacks: [5_000, 5_000, 5_000] });
  assert.equal(odd.reduce((sum, d) => sum + d, 0), 0);
  assert.equal(odd[0], 700);
});

test('a room always counts in silver, whatever the host asks for', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = new Client(host.url);
  await alice.ready();
  await alice.next(S2C.WELCOME);
  alice.send({ t: 'create', name: 'Alice', settings: { currency: 'gold', pot: 5, startingChips: 100, humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);
  assert.equal(created.room.settings.currency, 'silver', 'an old client asking for gold still gets silver');
  assert.equal(created.room.settings.pot, 5, 'a host may price a room small');
  assert.notEqual(created.room.settings.currency, SOLO_CURRENCY);

  const bob = new Client(host.url);
  await bob.ready();
  await bob.next(S2C.WELCOME);
  bob.send({ t: 'join', code: created.room.code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  assert.equal(joined.room.settings.currency, 'silver', 'a joiner is told which coins the room counts in');

  bob.drain(S2C.ROOM);
  alice.send({ t: 'settings', settings: { currency: 'gold', baseMultiplier: 5, capFactor: 7 } });
  const changed = await bob.next(S2C.ROOM);
  assert.equal(changed.room.settings.currency, 'silver', 'a settings update cannot switch the coin');
  assert.equal(changed.room.settings.baseMultiplier, 2, 'or the multiplier');
  assert.equal(changed.room.settings.capFactor, 100, 'or the hand ceiling');

  bob.drain(S2C.ROOM);
  alice.send({ t: 'settings', settings: { currency: 'chips' } });
  const refused = await bob.next(S2C.ROOM);
  assert.equal(refused.room.settings.currency, DEFAULT_ROOM_CURRENCY,
    'the single-player purse is not a coin a room can deal in');
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

test('a reset client keeps its seat held and the room plays on', async (t) => {
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
  const after = await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  assert.equal(after.room.seats[1].name, 'Bob', "Bob's seat is held for him, shown as away");

  // The host is still healthy enough to deal; the held seat plays as a bot.
  alice.send({ t: 'start' });
  const view = await alice.next(S2C.VIEW);
  assert.equal(view.view.you.hand.length, 17);
  assert.equal(view.view.players[1].isBot, true);
  alice.close();
});

/** Answer every VIEW that makes it this seat's turn with the simplest legal move. */
function autopilot(client) {
  let stopped = false;
  const act = (view) => {
    const seat = view.seat;
    if (view.phase === 'bidding' && view.bidding.turn === seat) {
      client.send({ t: 'bid', value: view.bidding.highest < 3 ? view.bidding.highest + 1 : 0 });
    } else if (view.phase === 'playing' && view.turn === seat) {
      const moves = legalPlays(view.you.hand, view.trick?.combo ?? null);
      if (moves.length) client.send({ t: 'play', cards: moves[0].cards.map((c) => c.id) });
      else client.send({ t: 'pass' });
    }
  };
  client.socket.addEventListener('message', (event) => {
    if (stopped) return;
    const message = JSON.parse(event.data);
    if (message.t === S2C.VIEW) act(message.view);
  });
  // The turn may already be sitting on this seat from a view that arrived
  // before the pilot was switched on.
  const latest = client.log.findLast((m) => m.t === S2C.VIEW);
  if (latest) act(latest.view);
  return () => { stopped = true; };
}

async function connect(host) {
  const client = new Client(host.url);
  await client.ready();
  await client.next(S2C.WELCOME);
  return client;
}

test('each member gets their own resume token and nobody sees anyone else\'s', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);
  assert.equal(typeof created.token, 'string');
  assert.ok(created.token.length >= 16);

  const bob = await connect(host);
  bob.send({ t: 'join', code: created.room.code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  assert.equal(typeof joined.token, 'string');
  assert.notEqual(joined.token, created.token);
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');

  for (const [who, client, token, other] of [
    ['Alice', alice, created.token, joined.token],
    ['Bob', bob, joined.token, created.token],
  ]) {
    const rooms = client.log.filter((m) => m.t === S2C.ROOM);
    assert.ok(rooms.length > 0);
    for (const frame of rooms) assert.equal(frame.token, token, `${who}'s ROOM frames carry ${who}'s token`);
    assert.equal(JSON.stringify(client.log).includes(other), false, `${who} never sees the other token`);
  }
  alice.close();
  bob.close();
});

test('a dropped player resumes mid-hand, takes the seat back from the bot, and the hand settles', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);
  const code = created.room.code;
  const bob = await connect(host);
  bob.send({ t: 'join', code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');

  // Alice stays quiet so the hand stalls on her turn while Bob is away.
  alice.send({ t: 'start' });
  await bob.next(S2C.VIEW);
  bob.close();
  const left = await alice.until(S2C.EVENT, (m) => m.kind === 'left');
  assert.equal(left.seat, 1);
  const away = await alice.until(S2C.VIEW, (m) => m.view.players[1].isBot);
  assert.match(away.view.players[1].name, /bot/);

  const back = await connect(host);
  back.send({ t: 'resume', code, token: joined.token });
  const room = await back.next(S2C.ROOM);
  assert.equal(room.you, joined.you, 'the member id survives the new socket');
  assert.equal(room.token, joined.token);
  const view = await back.next(S2C.VIEW);
  assert.equal(view.view.seat, 1);
  assert.equal(view.view.you.hand.length, 17);
  assert.equal(view.view.players[1].isBot, false, 'the seat is human again');
  assert.equal(view.view.players[1].name, 'Bob');
  await alice.until(S2C.EVENT, (m) => m.kind === 'back' && m.seat === 1);

  // The old id must not be needed: the resumed socket can play for the seat.
  autopilot(alice);
  autopilot(back);
  const result = await alice.next(S2C.RESULT, 20_000);
  assert.equal(result.rows[1].isBot, false);
  assert.equal(result.rows[1].name, 'Bob');
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(result.rows.reduce((sum, row) => sum + row.chips, 0), 3 * created.room.settings.startingChips,
    'chips are conserved across the drop and the resume');
  alice.close();
  back.close();
});

test('resuming with a token nobody holds is refused', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);

  const stranger = await connect(host);
  stranger.send({ t: 'resume', code: created.room.code, token: 'not-a-real-token' });
  const bad = await stranger.next(S2C.ERROR);
  assert.equal(bad.code, 'resume_failed');
  stranger.send({ t: 'resume', code: 'ZZZZZ', token: created.token });
  assert.equal((await stranger.next(S2C.ERROR)).code, 'resume_failed', 'an unknown room fails the same way');
  stranger.send({ t: 'resume', code: created.room.code });
  assert.equal((await stranger.next(S2C.ERROR)).code, 'resume_failed', 'a missing token fails too');
  alice.close();
  stranger.close();
});

test('a newcomer joining mid-hand watches as a spectator and can sit once it ends', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 3 } });
  const created = await alice.next(S2C.ROOM);
  const code = created.room.code;
  const bob = await connect(host);
  bob.send({ t: 'join', code, name: 'Bob' });
  await bob.next(S2C.ROOM);

  alice.send({ t: 'start' });
  await alice.next(S2C.VIEW);

  const carol = await connect(host);
  carol.send({ t: 'join', code, name: 'Carol' });
  const watching = await carol.next(S2C.ROOM);
  assert.equal(watching.room.phase, 'playing');
  assert.equal(typeof watching.token, 'string');
  assert.deepEqual(watching.room.spectators.map((s) => s.name), ['Carol']);
  assert.equal(watching.room.seats.some((s) => s.name === 'Carol'), false);

  autopilot(alice);
  autopilot(bob);
  await alice.next(S2C.RESULT, 20_000);
  assert.equal(carol.log.some((m) => m.t === S2C.VIEW), false, 'a spectator is never sent a seat\'s view');

  carol.send({ t: 'sit', seat: 2 });
  const seated = await alice.until(S2C.ROOM, (m) => m.room.seats[2].name === 'Carol');
  assert.equal(seated.room.spectators.length, 0);
  alice.close();
  bob.close();
  carol.close();
});

test('a full room gives a dropped member\'s seat to a newcomer, oldest drop first', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2 } });
  const created = await alice.next(S2C.ROOM);
  const code = created.room.code;
  const bob = await connect(host);
  bob.send({ t: 'join', code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');

  const dave = await connect(host);
  dave.send({ t: 'join', code, name: 'Dave' });
  const watching = await dave.next(S2C.ROOM);
  assert.deepEqual(watching.room.spectators.map((s) => s.name), ['Dave'], 'a full table seats a newcomer as a spectator');

  bob.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  dave.send({ t: 'join', code, name: 'Dave' });
  const taken = await dave.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Dave');
  assert.equal(taken.room.spectators.length, 0);

  const late = await connect(host);
  late.send({ t: 'resume', code, token: joined.token });
  assert.equal((await late.next(S2C.ERROR)).code, 'resume_failed', 'the evicted seat can no longer be resumed');
  alice.close();
  dave.close();
  late.close();
});

test('views carry a hand number that goes up on every deal', async (t) => {
  const host = await startHost();
  t.after(() => host.stop());

  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 1 } });
  await alice.next(S2C.ROOM);

  alice.send({ t: 'start' });
  const first = await alice.next(S2C.VIEW);
  assert.equal(first.hand, 1);
  const stop = autopilot(alice);
  await alice.next(S2C.RESULT, 20_000);
  stop();

  alice.send({ t: 'again' });
  const second = await alice.until(S2C.VIEW, (m) => m.hand === 2);
  assert.equal(second.view.you.hand.length, 17);
  alice.close();
});

test('the heartbeat drops a connection that goes silent and keeps one that answers', async (t) => {
  const server = createServer((req, res) => res.end('ok'));
  let silentClosed;
  const dropped = new Promise((resolve) => { silentClosed = resolve; });
  const sockets = attachWebSocket(server, {
    path: '/lan',
    heartbeatMs: 50,
    onConnection: (conn) => { conn.on('close', () => silentClosed(conn)); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  // A raw socket finishes the upgrade handshake and then says nothing, which is
  // what a phone that went to sleep looks like from the host.
  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => {
    raw.destroy();
    sockets.close();
    server.close();
    server.closeAllConnections?.();
  });
  await once(raw, 'connect');
  raw.write([
    'GET /lan HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n'));

  const live = new Client(`ws://127.0.0.1:${port}/lan`);
  t.after(() => live.close());
  await live.ready();

  const started = Date.now();
  const conn = await Promise.race([
    dropped,
    new Promise((_, reject) => setTimeout(() => reject(new Error('the silent connection was never dropped')), 2_000).unref()),
  ]);
  assert.equal(conn.open, false);
  assert.ok(Date.now() - started < 1_500);
  assert.equal(live.socket.readyState, 1, 'a browser that answers pings is left alone');
});

// --- resume/join regressions ---------------------------------------------------

/** startHost, but handing back the hub so a test can inspect rooms and call sweep(). */
async function startHub(options = {}) {
  const hub = new RoomHub({ botStepMs: 5, dealGraceMs: 0, ...options });
  const server = createServer((req, res) => res.end('ok'));
  const sockets = attachWebSocket(server, { path: '/lan', onConnection: (conn) => hub.attach(conn) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    hub,
    url: `ws://127.0.0.1:${port}/lan`,
    stop: () => {
      hub.close();
      sockets.close();
      server.close();
      server.closeAllConnections?.();
    },
  };
}

async function waitFor(condition, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Alice creates a room for two humans and Bob joins it. */
async function twoPlayerRoom(host, settings = {}) {
  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 2, ...settings } });
  const created = await alice.next(S2C.ROOM);
  const bob = await connect(host);
  bob.send({ t: 'join', code: created.room.code, name: 'Bob' });
  const joined = await bob.next(S2C.ROOM);
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');
  return { alice, bob, created, joined, code: created.room.code, room: host.hub.rooms.get(created.room.code) };
}

test('the host who dropped first can take the room back when its successor drops too', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, created, joined, code, room } = await twoPlayerRoom(host);

  alice.close();
  await bob.until(S2C.ROOM, (m) => m.room.hostId === joined.you);
  bob.close();
  await waitFor(() => !room.members.get(joined.you).connected);
  assert.equal(room.hostId, joined.you, 'the host stays on the last member while nobody is connected');

  const back = await connect(host);
  back.send({ t: 'resume', code, token: created.token });
  const resumed = await back.next(S2C.ROOM);
  assert.equal(resumed.room.hostId, created.you, 'the first one back is the host, not the absent successor');
  back.send({ t: 'start' });
  assert.equal((await back.next(S2C.VIEW)).view.you.hand.length, 17);
  back.close();
});

test('a host seat deleted by an explicit leave passes to the held member, who can then deal', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, joined, code, room } = await twoPlayerRoom(host);

  bob.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  alice.send({ t: 'leave' });
  await waitFor(() => room.members.size === 1);
  assert.equal(room.hostId, joined.you, 'hostId never names a deleted member');

  const back = await connect(host);
  back.send({ t: 'resume', code, token: joined.token });
  assert.equal((await back.next(S2C.ROOM)).room.hostId, joined.you);
  back.send({ t: 'start' });
  assert.equal((await back.next(S2C.VIEW)).view.you.hand.length, 17);
  alice.close();
  back.close();
});

test('a held seat expires after the TTL, keeping its chips for a rejoin under the same name', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, joined, code, room } = await twoPlayerRoom(host);
  room.chips.set(joined.you, 12_345);

  bob.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  host.hub.sweep();
  assert.equal(room.members.size, 2, 'inside the TTL the seat is still held');

  host.hub.options.heldSeatTtlMs = 20;
  await sleep(50);
  host.hub.sweep();
  const gone = await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === null);
  assert.equal(gone.room.seats[1].id, null);
  assert.equal(room.members.size, 1);

  const late = await connect(host);
  late.send({ t: 'resume', code, token: joined.token });
  assert.equal((await late.next(S2C.ERROR)).code, 'resume_failed', 'an expired seat cannot be resumed');

  late.send({ t: 'join', code, name: 'bob' });
  const back = await late.next(S2C.ROOM);
  assert.equal(back.room.seats[1].chips, 12_345, 'the stack comes back, matched on the name without case');
  alice.close();
  late.close();
});

test('leaving between hands and rejoining under the same name returns the same chips', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, created, code, room } = await twoPlayerRoom(host);
  const start = created.room.settings.startingChips;

  alice.send({ t: 'start' });
  const stops = [autopilot(alice), autopilot(bob)];
  const result = await alice.next(S2C.RESULT, 20_000);
  for (const stop of stops) stop();
  const kept = result.rows[1].chips;
  assert.notEqual(kept, start, 'the hand moved Bob\'s stack, so the check below means something');

  bob.send({ t: 'leave' });
  await waitFor(() => room.members.size === 1);
  assert.equal(room.departed.get('bob'), kept);
  bob.drain(S2C.ROOM);
  bob.send({ t: 'join', code, name: 'Bob' });
  const back = await bob.next(S2C.ROOM);
  assert.equal(back.room.seats[1].chips, kept);
  assert.equal(room.departed.size, 0, 'the stashed stack is used once');
  assert.equal([...room.chips.values()].reduce((a, b) => a + b, 0), 3 * start, 'no chips minted or wiped');
  alice.close();
  bob.close();
});

test('leaving mid-hand files the settled purse under the leaver\'s name', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, joined, created, code, room } = await twoPlayerRoom(host);
  const start = created.room.settings.startingChips;

  alice.send({ t: 'start' });
  await bob.next(S2C.VIEW);
  bob.send({ t: 'leave' });
  autopilot(alice);
  const result = await alice.next(S2C.RESULT, 20_000);
  const kept = result.rows[1].chips;
  assert.equal(room.departed.get('bob'), kept);
  assert.equal(room.chips.has(joined.you), false, 'nothing is left keyed by the old member id');
  assert.equal([...room.chips.values()].reduce((a, b) => a + b, 0) + kept, 3 * start);

  bob.drain(S2C.ROOM);
  bob.send({ t: 'join', code, name: 'Bob' });
  assert.equal((await bob.next(S2C.ROOM)).room.seats[1].chips, kept);
  alice.close();
  bob.close();
});

test('a drop and resume inside the deal grace does not let the bots start early', async (t) => {
  const host = await startHub({ botStepMs: 20, dealGraceMs: 400 });
  t.after(() => host.stop());
  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice', settings: { humanSeats: 1 } });
  const created = await alice.next(S2C.ROOM);
  const room = host.hub.rooms.get(created.room.code);

  // The first bidder is random; redeal until a bot is first so the timer under test exists.
  let dealtAt;
  do {
    host.hub.deal(room);
    dealtAt = Date.now();
  } while (!room.state.players[room.state.bidding.turn].isBot);

  alice.close();
  await waitFor(() => !room.members.get(created.you).connected);
  const back = await connect(host);
  back.send({ t: 'resume', code: created.room.code, token: created.token });
  await back.next(S2C.ROOM);
  assert.ok(Date.now() - dealtAt < 300, 'the resume landed inside the grace, or this test proves nothing');

  await waitFor(() => room.state.bidding.calls.length > 0, 2_000);
  assert.ok(Date.now() - dealtAt >= 380, `the first bot acted ${Date.now() - dealtAt}ms after the deal`);
  back.close();
});

test('a socket closed as replaced is destroyed even if the peer never answers', async (t) => {
  const server = createServer((req, res) => res.end('ok'));
  let gotConn;
  const connected = new Promise((resolve) => { gotConn = resolve; });
  const sockets = attachWebSocket(server, { path: '/lan', onConnection: (conn) => gotConn(conn) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const raw = net.connect(port, '127.0.0.1');
  raw.on('error', () => {});
  t.after(() => {
    raw.destroy();
    sockets.close();
    server.close();
    server.closeAllConnections?.();
  });
  await once(raw, 'connect');
  // Never read from `raw`: its end of the socket then never sends the FIN that
  // end() on the host side waits for, which is a half-dead peer.
  raw.pause();
  raw.write([
    'GET /lan HTTP/1.1',
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '\r\n',
  ].join('\r\n'));
  const conn = await connected;

  conn.close(4000, 'replaced');
  assert.equal(conn.open, false);
  await sleep(1_300);
  assert.equal(conn.socket.destroyed, true, 'the fd is released without waiting for the peer');
});

test('a newcomer resuming after a hand does not get the previous holder\'s hand or result', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, created, code } = await twoPlayerRoom(host);

  alice.send({ t: 'start' });
  const stops = [autopilot(alice), autopilot(bob)];
  await alice.next(S2C.RESULT, 20_000);
  for (const stop of stops) stop();

  bob.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  const dave = await connect(host);
  dave.send({ t: 'join', code, name: 'Dave' });
  const joined = await dave.next(S2C.ROOM);
  assert.equal(joined.room.seats[1].name, 'Dave', 'Dave took the dropped seat');
  dave.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Dave' && m.room.seats[1].connected === false);

  const back = await connect(host);
  back.send({ t: 'resume', code, token: joined.token });
  assert.equal((await back.next(S2C.ROOM)).room.phase, 'finished');
  await sleep(150);
  assert.equal(back.log.some((m) => m.t === S2C.VIEW), false, 'no view of Bob\'s cards');
  assert.equal(back.log.some((m) => m.t === S2C.RESULT), false, 'no result row for a hand Dave did not play');

  // Control: someone who did play still gets both.
  const again = await connect(host);
  again.send({ t: 'resume', code, token: created.token });
  await again.next(S2C.VIEW);
  await again.next(S2C.RESULT);
  alice.close();
  back.close();
  again.close();
});

test('joining the full room you already sit in swaps your seat instead of being refused', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, code } = await twoPlayerRoom(host);

  bob.drain(S2C.ROOM);
  bob.send({ t: 'join', code, name: 'Bob' });
  const again = await bob.next(S2C.ROOM);
  assert.equal(again.room.seats[1].name, 'Bob');
  assert.equal(again.room.seats[1].connected, true);
  assert.equal(bob.log.some((m) => m.t === S2C.ERROR), false);
  alice.close();
  bob.close();
});

// --- Big Two and hosting ------------------------------------------------------

/** Like autopilot(), for Big Two: lead or beat with the first legal play, else pass. */
function big2Autopilot(client) {
  let stopped = false;
  const act = (view) => {
    if (view.phase !== 'playing' || view.turn !== view.seat) return;
    const opts = { mustInclude: view.leadMustInclude };
    const moves = bigTwoPlays(view.you.hand, view.trick?.combo ?? null, opts);
    if (moves.length) client.send({ t: 'play', cards: moves[0].cards.map((c) => c.id) });
    else client.send({ t: 'pass' });
  };
  client.socket.addEventListener('message', (event) => {
    if (stopped) return;
    const message = JSON.parse(event.data);
    if (message.t === S2C.VIEW) act(message.view);
  });
  const latest = client.log.findLast((m) => m.t === S2C.VIEW);
  if (latest) act(latest.view);
  return () => { stopped = true; };
}

test('a Dou Di Zhu hand reveals all three hands in the last view, and not before', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob } = await twoPlayerRoom(host);

  autopilot(alice);
  autopilot(bob);
  alice.send({ t: 'start' });
  await alice.next(S2C.RESULT, 30_000);

  const views = alice.log.filter((m) => m.t === S2C.VIEW).map((m) => m.view);
  const firstFinished = views.findIndex((v) => v.phase === 'finished');
  assert.ok(firstFinished >= 0, 'a finished view arrives before the result');
  assert.equal(views[firstFinished].revealedHands.length, 3, 'every hand is public once the deal ends');
  for (const v of views.slice(0, firstFinished)) {
    assert.equal('revealedHands' in v, false, 'no hand is revealed mid-deal');
  }
  alice.close();
  bob.close();
});

test('a Big Two room seats four, plays a hand with two bots, and conserves chips', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, created } = await twoPlayerRoom(host, { game: 'big2', pot: 1_000, startingChips: 10_000, botSkill: 'casual' });
  assert.equal(created.room.settings.game, 'big2');
  assert.equal(created.room.seats.length, 4);
  assert.equal('baseMultiplier' in created.room.settings, false, 'Big Two carries no Dou Di Zhu multiplier');

  big2Autopilot(alice);
  big2Autopilot(bob);
  alice.send({ t: 'start' });
  const result = await alice.next(S2C.RESULT, 30_000);

  assert.equal(result.game, 'big2');
  assert.equal(result.rate, 100);
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(result.rows.reduce((sum, row) => sum + row.chips, 0), 4 * 10_000);
  const winner = result.rows[result.winner];
  assert.equal(winner.won, true);
  assert.equal(winner.cardsLeft, 0);
  for (const row of result.rows.filter((r) => !r.won)) {
    assert.equal(row.delta, -row.cardsLeft * 100);
    assert.equal(row.chips, 10_000 + row.delta);
  }
  const final = alice.log.findLast((m) => m.t === S2C.VIEW).view;
  assert.equal(final.phase, 'finished');
  assert.equal(final.revealedHands.length, 4, 'every hand is public once the hand ends');
  alice.close();
  bob.close();
});

test('a Big Two payout is capped at each loser bankroll and the winner gets only what was paid', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob } = await twoPlayerRoom(host, { game: 'big2', pot: 1_000, startingChips: 150, botSkill: 'casual' });
  big2Autopilot(alice);
  big2Autopilot(bob);
  alice.send({ t: 'start' });
  const result = await alice.next(S2C.RESULT, 30_000);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(result.rows.reduce((sum, row) => sum + row.chips, 0), 4 * 150);
  for (const row of result.rows) assert.ok(row.chips >= 0);
  for (const row of result.rows.filter((r) => !r.won)) {
    assert.ok(row.delta >= -150);
    assert.equal(row.capped, row.cardsLeft * 100 > 150);
  }
  assert.ok(result.rows.some((r) => r.capped), 'with a 150 stack at 100 a card, someone is capped');
  alice.close();
  bob.close();
});

test('Big Two plays and passes are announced before the view that shows them', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob } = await twoPlayerRoom(host, { game: 'big2', botSkill: 'casual' });
  big2Autopilot(alice);
  big2Autopilot(bob);
  alice.send({ t: 'start' });
  await alice.next(S2C.RESULT, 30_000);

  let previous = null;
  let pending = [];
  let plays = 0;
  let passes = 0;
  let resolvedPasses = 0;
  let leads = 0;
  for (const frame of alice.log) {
    if (frame.t === S2C.EVENT && (frame.kind === 'play' || frame.kind === 'pass')) {
      pending.push(frame);
    } else if (frame.t === S2C.VIEW) {
      const { view } = frame;
      const moved = previous ? view.history.length - previous.history.length : 0;
      assert.equal(pending.length, moved, 'one event per move, ahead of the view that carries it');
      if (pending.length) {
        const [event] = pending;
        const last = view.history[view.history.length - 1];
        assert.equal(event.seat, last.seat);
        assert.equal(event.kind, last.action);
        if (event.kind === 'play') {
          plays += 1;
          assert.deepEqual(event.cards.map((c) => c.id), last.combo.cards.map((c) => c.id));
          assert.equal(event.leading, previous.trick === null, 'leading means no trick was standing');
          if (event.leading) leads += 1;
        } else {
          passes += 1;
          assert.equal(event.resolved, view.trick === null, 'resolved means the pass cleared the trick');
          if (event.resolved) resolvedPasses += 1;
        }
      }
      pending = [];
      previous = view;
    }
  }
  assert.ok(plays > 0 && passes > 0 && leads > 0 && resolvedPasses > 0,
    `a whole hand shows plays (${plays}), passes (${passes}), leads (${leads}) and a cleared trick (${resolvedPasses})`);
  alice.close();
  bob.close();
});

test('a bid is refused in a Big Two room', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice } = await twoPlayerRoom(host, { game: 'big2' });
  alice.send({ t: 'start' });
  await alice.next(S2C.VIEW);
  alice.send({ t: 'bid', value: 1 });
  assert.match((await alice.next(S2C.ERROR)).message, /not part of this game/);
  alice.close();
});

test('humanSeats clamps to the seats the game has, and only set_game changes the game', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());

  const big = await connect(host);
  big.send({ t: 'create', name: 'Big', settings: { game: 'big2', humanSeats: 9 } });
  const bigRoom = (await big.next(S2C.ROOM)).room;
  assert.equal(bigRoom.settings.humanSeats, 4);
  assert.equal(bigRoom.seats.length, 4);
  big.send({ t: 'settings', settings: { game: 'doudizhu', pot: 50 } });
  const updated = (await big.until(S2C.ROOM, (m) => m.room.settings.pot === 50)).room;
  assert.equal(updated.settings.game, 'big2', 'a settings update cannot switch the game');
  assert.equal(updated.seats.length, 4);
  big.send({ t: 'seat_fill', humanSeats: 9 });
  assert.equal((await big.until(S2C.ROOM, (m) => m.room.settings.humanSeats === 4)).room.seats.length, 4);
  big.send({ t: 'set_game', game: 'doudizhu' });
  const switched = (await big.until(S2C.ROOM, (m) => m.room.settings.game === 'doudizhu')).room;
  assert.equal(switched.seats.length, 3);
  assert.equal(switched.settings.humanSeats, 3);
  assert.equal(switched.seats[0].name, 'Big');
  big.send({ t: 'set_game', game: 'poker' });
  assert.match((await big.next(S2C.ERROR)).message, /unknown game/);

  const dou = await connect(host);
  dou.send({ t: 'create', name: 'Dou', settings: { game: 'doudizhu', humanSeats: 9 } });
  const douRoom = (await dou.next(S2C.ROOM)).room;
  assert.equal(douRoom.settings.humanSeats, 3);
  assert.equal(douRoom.seats.length, 3);

  const odd = await connect(host);
  odd.send({ t: 'create', name: 'Odd', settings: { game: 'poker' } });
  assert.equal((await odd.next(S2C.ROOM)).room.settings.game, 'doudizhu', 'an unknown game is Dou Di Zhu');
  big.close();
  dou.close();
  odd.close();
});

test('a dropped Big Two player resumes mid-hand and takes the seat back from the bot', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { alice, bob, joined, code } = await twoPlayerRoom(host, { game: 'big2', pot: 1_000, startingChips: 10_000, botSkill: 'casual' });

  // Alice stays quiet so the hand stalls on her turn while Bob is away.
  alice.send({ t: 'start' });
  await bob.next(S2C.VIEW);
  bob.close();
  const left = await alice.until(S2C.EVENT, (m) => m.kind === 'left');
  assert.equal(left.seat, 1);
  const away = await alice.until(S2C.VIEW, (m) => !m.view.players[1].isHuman);
  assert.match(away.view.players[1].name, /bot/);

  const back = await connect(host);
  back.send({ t: 'resume', code, token: joined.token });
  const room = await back.next(S2C.ROOM);
  assert.equal(room.you, joined.you);
  const view = (await back.next(S2C.VIEW)).view;
  assert.equal(view.seat, 1);
  assert.equal(view.players[1].isHuman, true, 'the seat is human again');
  assert.equal(view.players[1].name, 'Bob');
  assert.ok(view.you.hand.length > 0 && view.you.hand.length <= 13);
  await alice.until(S2C.EVENT, (m) => m.kind === 'back' && m.seat === 1);

  big2Autopilot(alice);
  big2Autopilot(back);
  const result = await alice.next(S2C.RESULT, 30_000);
  assert.equal(result.game, 'big2');
  assert.equal(result.rows[1].isBot, false);
  assert.equal(result.rows[1].name, 'Bob');
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(result.rows.reduce((sum, row) => sum + row.chips, 0), 4 * 10_000);
  alice.close();
  back.close();
});

test('a public server hides its LAN address and says so in the welcome', async (t) => {
  const open = await startHub({ public: true, advertisedHost: '192.168.1.5', port: 8787 });
  const lan = await startHub({ advertisedHost: '192.168.1.5', port: 8787 });
  t.after(() => { open.stop(); lan.stop(); });

  const online = new Client(open.url);
  await online.ready();
  const welcome = await online.next(S2C.WELCOME);
  assert.equal(welcome.host, null);
  assert.equal(welcome.public, true);

  const local = new Client(lan.url);
  await local.ready();
  const localWelcome = await local.next(S2C.WELCOME);
  assert.equal(localWelcome.host, '192.168.1.5');
  assert.equal(localWelcome.public, false);
  online.close();
  local.close();
});

test('creating a room at the cap is refused with server_full', async (t) => {
  const host = await startHub({ maxRooms: 1 });
  t.after(() => host.stop());
  const first = await connect(host);
  first.send({ t: 'create', name: 'First' });
  await first.next(S2C.ROOM);

  const second = await connect(host);
  second.send({ t: 'create', name: 'Second' });
  const refused = await second.next(S2C.ERROR);
  assert.equal(refused.code, 'server_full');
  assert.equal(host.hub.rooms.size, 1);

  // Joining an existing room still works at the cap.
  second.send({ t: 'join', code: [...host.hub.rooms.keys()][0], name: 'Second' });
  assert.equal((await second.next(S2C.ROOM)).room.seats[1].name, 'Second');
  first.close();
  second.close();
});

// --- a throw inside a table resets it to its lobby -----------------------------

test('a bot turn that throws returns the room to its lobby, and the next deal works', async (t) => {
  const quiet = console.error;
  console.error = () => {};
  t.after(() => { console.error = quiet; });
  const host = await startHub({ botStepMs: 5 });
  t.after(() => host.stop());
  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice' });
  const created = await alice.next(S2C.ROOM);
  const room = host.hub.rooms.get(created.room.code);
  const real = room.adapter;
  room.adapter = { ...real, isBotTurn: () => true, botTurn: () => { throw new Error('boom'); } };

  alice.send({ t: 'start' });
  const error = await alice.next(S2C.ERROR);
  assert.match(error.message, /reset/);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.state, null);
  assert.equal(room.lastResult, null);

  room.adapter = real;
  alice.drain(S2C.VIEW);
  alice.send({ t: 'start' });
  assert.equal((await alice.next(S2C.VIEW)).view.you.hand.length, 17);
  alice.close();
});

test('a throw after a move is applied resets the room instead of leaving it playing', async (t) => {
  const quiet = console.error;
  console.error = () => {};
  t.after(() => { console.error = quiet; });
  const host = await startHub({ botStepMs: 60_000 });
  t.after(() => host.stop());
  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice' });
  const created = await alice.next(S2C.ROOM);
  const room = host.hub.rooms.get(created.room.code);
  alice.send({ t: 'start' });
  await alice.next(S2C.VIEW);
  assert.equal(room.phase, 'playing');
  alice.drain(S2C.ROOM);

  const real = room.adapter;
  room.adapter = {
    ...real,
    actions: { ...real.actions, [C2S.BID]: () => ({ ok: true }) },
    describeAction: () => [],
    isFinished: () => { throw new Error('after the move'); },
  };
  alice.send({ t: 'bid', bid: 1 });
  await alice.until(S2C.ROOM, (m) => m.room.phase === 'lobby');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.state, null);
  room.adapter = real;
});

test('a deal that throws leaves the room in its lobby', async (t) => {
  const quiet = console.error;
  console.error = () => {};
  t.after(() => { console.error = quiet; });
  const host = await startHub();
  t.after(() => host.stop());
  const alice = await connect(host);
  alice.send({ t: 'create', name: 'Alice' });
  const created = await alice.next(S2C.ROOM);
  const room = host.hub.rooms.get(created.room.code);
  const real = room.adapter;
  room.adapter = { ...real, createGame: () => { throw new Error('bad deal'); } };
  alice.send({ t: 'start' });
  assert.match((await alice.next(S2C.ERROR)).message, /reset/);
  assert.equal(room.phase, 'lobby');
  room.adapter = real;
  alice.close();
});

// --- switching games and spectators ---------------------------------------------

/** A lobby of `names` (the first is the host), each seated or watching as the server placed them. */
async function roomOf(host, names, settings = {}) {
  const [first, ...rest] = names;
  const clients = {};
  clients[first] = await connect(host);
  clients[first].send({ t: 'create', name: first, settings });
  const created = await clients[first].next(S2C.ROOM);
  const ids = { [first]: created.you };
  for (const name of rest) {
    clients[name] = await connect(host);
    clients[name].send({ t: 'join', code: created.room.code, name });
    ids[name] = (await clients[name].next(S2C.ROOM)).you;
  }
  await clients[first].until(
    S2C.ROOM,
    (m) => m.room.seats.filter((s) => s.id).length + m.room.spectators.length === names.length,
  );
  return { clients, ids, code: created.room.code, room: host.hub.rooms.get(created.room.code) };
}

test('switching Dou Di Zhu to Big Two seats the spectator and keeps every purse', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob', 'Carol', 'Dan'], {
    game: 'doudizhu', pot: 100, startingChips: 2_500, humanSeats: 3,
  });
  const { Alice, Bob, Carol, Dan } = clients;
  // Different purses, so "kept" cannot be satisfied by everyone holding the same stack.
  room.chips.set(ids.Alice, 3_100);
  room.chips.set(ids.Bob, 1_900);
  room.chips.set(ids.Carol, 2_500);
  room.chips.set(ids.Dan, 777);
  room.departed.set('eve', 400);

  Alice.send({ t: 'set_game', game: 'big2' });
  const switched = (await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'big2')).room;
  assert.equal(switched.seats.length, 4);
  assert.deepEqual(switched.seats.map((s) => s.name), ['Alice', 'Bob', 'Carol', 'Dan']);
  assert.deepEqual(switched.seats.map((s) => s.chips), [3_100, 1_900, 2_500, 777]);
  assert.equal(switched.spectators.length, 0);
  assert.equal(switched.settings.pot, potForStack('big2', 2_500));
  assert.equal(switched.settings.startingChips, 2_500);
  assert.equal(switched.settings.humanSeats, 4);
  assert.equal(switched.phase, 'lobby');
  assert.equal(room.departed.get('eve'), 400, 'a switch leaves the purses of people away alone');

  for (const c of Object.values(clients)) c.drain(S2C.VIEW);
  Alice.send({ t: 'start' });
  for (const c of [Alice, Bob, Carol, Dan]) {
    const view = (await c.next(S2C.VIEW)).view;
    assert.equal(view.players.length, 4);
    assert.equal(view.you.hand.length, 13);
  }
  for (const c of Object.values(clients)) c.close();
});

test('switching Big Two to Dou Di Zhu stands one non-host down and keeps the host seated', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob', 'Carol', 'Dan'], { game: 'big2', humanSeats: 4 });
  const { Alice, Dan } = clients;

  Alice.send({ t: 'set_game', game: 'doudizhu' });
  const switched = (await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'doudizhu')).room;
  assert.equal(switched.seats.length, 3);
  assert.equal(switched.seats[0].name, 'Alice');
  assert.deepEqual(switched.spectators.map((s) => s.name), ['Dan']);
  assert.equal(switched.settings.humanSeats, 3);
  assert.equal(room.members.get(ids.Dan).seat, null);
  assert.equal(room.members.get(ids.Dan).conn.data.seat, null);

  // Growing back seats Dan again; then put the host in the last seat, where a
  // shrink would drop her if the rule did not protect the host.
  Alice.send({ t: 'set_game', game: 'big2' });
  await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'big2' && m.room.seats[3].name === 'Dan');
  Dan.send({ t: 'stand' });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[3].name === null);
  Alice.send({ t: 'sit', seat: 3 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[3].name === 'Alice');
  Dan.send({ t: 'sit', seat: 0 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[0].name === 'Dan');
  Alice.send({ t: 'set_game', game: 'doudizhu' });
  const hostLast = (await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'doudizhu')).room;
  assert.deepEqual(hostLast.seats.map((s) => s.name), ['Dan', 'Bob', 'Alice']);
  assert.deepEqual(hostLast.spectators.map((s) => s.name), ['Carol']);
  for (const c of Object.values(clients)) c.close();
});

test('a spectator can sit in a bot seat and a player can stand, but only the host moves others', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids } = await roomOf(host, ['Alice', 'Bob'], { game: 'doudizhu', humanSeats: 1 });
  const { Alice, Bob } = clients;

  Bob.send({ t: 'sit', seat: 0 });
  assert.match((await Bob.next(S2C.ERROR)).message, /taken/);
  Bob.send({ t: 'sit', seat: 7 });
  assert.match((await Bob.next(S2C.ERROR)).message, /taken/);

  Bob.send({ t: 'sit', seat: 1 });
  const sat = (await Alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob')).room;
  assert.equal(sat.spectators.length, 0);
  assert.equal(sat.settings.humanSeats, 2);

  Bob.send({ t: 'stand', id: ids.Alice });
  assert.match((await Bob.next(S2C.ERROR)).message, /only the room host/);

  Bob.send({ t: 'stand' });
  const stood = (await Alice.until(S2C.ROOM, (m) => m.room.seats[1].name === null)).room;
  assert.deepEqual(stood.spectators.map((s) => s.name), ['Bob']);
  assert.equal(stood.seats[1].bot, true);

  Bob.send({ t: 'sit', seat: 2 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[2].name === 'Bob');
  Alice.send({ t: 'stand', id: ids.Bob });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[2].name === null && m.room.spectators.length === 1);

  Bob.send({ t: 'sit', seat: 1 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[1].name === 'Bob');
  Alice.send({ t: 'start' });
  await Alice.next(S2C.VIEW);
  Bob.send({ t: 'stand' });
  assert.match((await Bob.next(S2C.ERROR)).message, /wait for the hand to end/);
  Bob.send({ t: 'sit', seat: 2 });
  assert.match((await Bob.next(S2C.ERROR)).message, /wait for the hand to end/);
  for (const c of Object.values(clients)) c.close();
});

test('set_game is the host\'s alone and not while a hand is running', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients } = await roomOf(host, ['Alice', 'Bob'], { game: 'doudizhu', humanSeats: 2 });
  const { Alice, Bob } = clients;

  Bob.send({ t: 'set_game', game: 'big2' });
  assert.match((await Bob.next(S2C.ERROR)).message, /only the room host/);

  Alice.send({ t: 'start' });
  await Alice.next(S2C.VIEW);
  Alice.send({ t: 'set_game', game: 'big2' });
  assert.match((await Alice.next(S2C.ERROR)).message, /finish the hand/);
  Alice.send({ t: 'to_lobby' });
  assert.match((await Alice.next(S2C.ERROR)).message, /finish the hand/);
  for (const c of Object.values(clients)) c.close();
});

test('to_lobby leaves a finished hand and then the game can be changed', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients } = await roomOf(host, ['Alice'], { game: 'doudizhu', humanSeats: 1 });
  const { Alice } = clients;

  autopilot(Alice);
  Alice.send({ t: 'start' });
  await Alice.next(S2C.RESULT, 30_000);
  await Alice.until(S2C.ROOM, (m) => m.room.phase === 'finished');

  Alice.send({ t: 'to_lobby' });
  await Alice.until(S2C.ROOM, (m) => m.room.phase === 'lobby');
  Alice.send({ t: 'set_game', game: 'big2' });
  const switched = (await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'big2')).room;
  assert.equal(switched.seats.length, 4);
  assert.equal(switched.phase, 'lobby');
  Alice.close();
});

test('a full room never evicts a seated player who dropped mid-hand', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const names = ['Alice', 'Bob', 'Carol', 'S1', 'S2', 'S3', 'S4', 'S5'];
  const { clients, ids, code, room } = await roomOf(host, names, { game: 'doudizhu', humanSeats: 3, startingChips: 2_500, pot: 100 });
  clients.Alice.send({ t: 'start' });
  await clients.Alice.next(S2C.VIEW);

  clients.Carol.close();
  await waitFor(() => !room.members.get(ids.Carol).connected);

  const ninth = await connect(host);
  ninth.send({ t: 'join', code, name: 'Ninth' });
  assert.match((await ninth.next(S2C.ERROR)).message, /full/);
  assert.equal(room.members.has(ids.Carol), true, 'the dropped player keeps their seat');
  assert.equal(room.chips.get(ids.Carol), 2_500, 'and their purse is not stashed under their name');
  assert.equal(room.departed.has('carol'), false);
  ninth.close();
  for (const c of Object.values(clients)) c.close();
});

test('switching to Big Two lifts a stack below its floor and leaves purses alone', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, room } = await roomOf(host, ['Alice', 'Bob'], { game: 'doudizhu', humanSeats: 2, startingChips: 25, pot: 1 });
  assert.equal(room.settings.startingChips, 25);

  clients.Alice.send({ t: 'set_game', game: 'big2' });
  const switched = (await clients.Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'big2')).room;
  assert.equal(switched.settings.startingChips, BIG2_MIN_STACK);
  assert.equal(switched.settings.pot, potForStack('big2', BIG2_MIN_STACK));
  assert.deepEqual(switched.seats.slice(0, 2).map((s) => s.chips), [25, 25]);
  for (const c of Object.values(clients)) c.close();
});

test('a hand cannot be dealt when nobody is sitting at the table', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients } = await roomOf(host, ['Alice'], { game: 'doudizhu', humanSeats: 1 });
  const { Alice } = clients;

  Alice.send({ t: 'stand' });
  await Alice.until(S2C.ROOM, (m) => m.room.spectators.length === 1);
  Alice.send({ t: 'start' });
  assert.match((await Alice.next(S2C.ERROR)).message, /nobody is sitting/);
  Alice.send({ t: 'again' });
  assert.match((await Alice.next(S2C.ERROR)).message, /nobody is sitting/);
  Alice.close();
});

// --- Malaysian Blackjack -----------------------------------------------------

/** Plays a client's blackjack seat as frames arrive: players hit to 16 then stand, the banker draws to 16 then opens. */
function autoplayBlackjack(client, inspect) {
  client.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.t !== S2C.VIEW) return;
    const { view } = message;
    inspect?.(view);
    if (view.seat === 0) {
      if (view.you.openable.length) client.send({ t: 'bj_open', seat: view.you.openable[0] });
      else if (view.you.canBankerHit) client.send({ t: 'bj_hit' });
    } else if (view.you.canStand) {
      client.send({ t: 'bj_stand' });
    } else if (view.you.canHit) {
      client.send({ t: 'bj_hit' });
    }
  });
}

const bjSettings = { game: 'blackjack', humanSeats: 2, pot: 10, startingChips: 1_000, botSkill: 'casual' };

function bjPlayers(humanSeats, extra = {}) {
  return Array.from({ length: 5 }, (_, seat) => (humanSeats.includes(seat)
    ? { id: `human-${seat}`, name: `H${seat}`, isBot: false, chips: 500, ...extra }
    : { id: `bot-${seat}`, name: `B${seat}`, isBot: true, chips: 1_000 }));
}

test('a human banker and a human player play blackjack rounds that conserve chips', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob'], bjSettings);
  const { Alice, Bob } = clients;
  assert.equal(room.seats.length, 5);
  assert.equal(room.members.get(ids.Alice).seat, 0);
  assert.equal(room.members.get(ids.Bob).seat, 1);

  const leaks = [];
  autoplayBlackjack(Alice, (view) => {
    if (view.phase !== 'players') return;
    for (const seat of view.seats) {
      if (seat && !seat.opened && (seat.cards.some((c) => c !== null) || seat.total !== null)) leaks.push(`banker sees seat ${seat.seat}`);
    }
  });
  autoplayBlackjack(Bob, (view) => {
    if (view.phase === 'players' && (view.banker.cards[1] !== null || view.banker.total !== null)) leaks.push('player sees the banker');
  });

  let previous = null;
  for (let round = 0; round < 6; round++) {
    Alice.send({ t: round === 0 ? 'start' : 'again' });
    const [a, b] = await Promise.all([Alice.next(S2C.RESULT, 8_000), Bob.next(S2C.RESULT, 8_000)]);
    assert.deepEqual(a.rows, b.rows);
    assert.equal(a.game, 'blackjack');
    assert.equal(a.rows.reduce((sum, row) => sum + row.delta, 0), 0, 'a settlement moves chips between seats, never mints them');
    assert.equal(a.rows[0].seat, 0);
    assert.equal(a.rows[0].isBanker, true);
    assert.equal(a.rows[0].isBot, false);
    for (const row of a.rows) {
      assert.equal(row.won, row.delta > 0);
      assert.ok(row.chips >= 0);
    }
    const alice = a.rows.find((row) => row.name === 'Alice');
    const bob = a.rows.find((row) => row.name === 'Bob');
    assert.equal(room.chips.get(ids.Alice), alice.chips);
    assert.equal(room.chips.get(ids.Bob), bob.chips);
    if (previous) {
      assert.equal(alice.chips - alice.delta, previous.alice, 'chips carry from one round to the next');
      assert.equal(bob.chips - bob.delta, previous.bob);
    }
    previous = { alice: alice.chips, bob: bob.chips };
  }
  assert.deepEqual(leaks, []);
  Alice.close();
  Bob.close();
});

test('blackjack views hide the banker\'s hole card from players and unopened hands from the banker', () => {
  const adapter = gameAdapter('blackjack');
  const settings = { pot: 10, startingChips: 1_000 };
  let checked = 0;
  for (let n = 0; n < 40 && checked < 5; n++) {
    const state = adapter.createGame({ seed: `view-${n}`, players: bjPlayers([0, 1], { bet: 20 }), settings });
    if (state.round.phase !== 'players') continue;
    checked += 1;

    const bankerView = adapter.seatView(state, 0);
    for (const seat of bankerView.seats) {
      if (!seat || seat.opened) continue;
      assert.ok(seat.count >= 2);
      assert.equal(seat.cards.length, seat.count);
      assert.ok(seat.cards.every((c) => c === null));
      assert.equal(seat.total, null);
      assert.equal(seat.busted, null);
      assert.equal(seat.special, null);
    }
    assert.equal(bankerView.banker.cards.length, 2);
    assert.ok(bankerView.banker.cards.every((c) => c !== null));

    const playerView = adapter.seatView(state, 1);
    assert.notEqual(playerView.banker.cards[0], null);
    assert.equal(playerView.banker.cards[1], null);
    assert.equal(playerView.banker.count, 2);
    assert.equal(playerView.banker.total, null);
    assert.equal(playerView.banker.special, null);
    assert.ok(playerView.seats[0].cards.every((c) => c !== null), 'a player sees their own cards');

    const wire = JSON.stringify(playerView);
    assert.equal(wire.includes(JSON.stringify(state.round.banker.cards[1])), false, 'the hole card never goes on the wire');
    const bankerWire = JSON.stringify(bankerView);
    for (const p of state.round.players) {
      if (p && !p.opened) for (const card of p.cards) assert.equal(bankerWire.includes(JSON.stringify(card)), false);
    }
    assert.equal(bankerView.you.canBankerHit, false);
    assert.deepEqual(bankerView.you.openable, []);
  }
  assert.ok(checked > 0, 'some seeds leave the round in the players phase');
});

test('blackjack bets are clamped to the table limits and to the purse, and only player seats may bet', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob', 'Cara'], { ...bjSettings, startingChips: 250 });
  const { Alice, Bob, Cara } = clients;
  assert.equal(room.members.get(ids.Cara).seat, null);

  const lobby = host.hub.describe(room);
  assert.equal(lobby.seats[0].bet, null);
  assert.equal(lobby.seats[1].bet, 10, 'an unset bet shows the table minimum');

  Bob.send({ t: 'bj_bet', amount: 5_000 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[1].bet === 100);
  assert.equal(room.bets.get(ids.Bob), 100);

  Bob.send({ t: 'bj_bet', amount: 1 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[1].bet === 10);

  room.chips.set(ids.Bob, 40);
  Bob.send({ t: 'bj_bet', amount: 500 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[1].bet === 40);

  Alice.send({ t: 'bj_bet', amount: 20 });
  assert.match((await Alice.next(S2C.ERROR)).message, /player seat/);
  Cara.send({ t: 'bj_bet', amount: 20 });
  assert.match((await Cara.next(S2C.ERROR)).message, /player seat/);
  Bob.send({ t: 'bj_bet', amount: 'lots' });
  assert.match((await Bob.next(S2C.ERROR)).message, /amount/);
  assert.equal(room.bets.has(ids.Alice), false);
  assert.equal(room.bets.has(ids.Cara), false);

  const adapter = gameAdapter('blackjack');
  const settings = { pot: 10, startingChips: 250 };
  const rich = adapter.createGame({ seed: 'bet', players: bjPlayers([0, 1], { bet: 5_000, chips: 400 }), settings });
  assert.equal(rich.round.players[0].bet, 100, 'the deal caps a stale bet at the table maximum');
  const poor = adapter.createGame({ seed: 'bet', players: bjPlayers([0, 1], { bet: 100, chips: 35 }), settings });
  assert.equal(poor.round.players[0].bet, 35, 'and at the chips the player has');
  const broke = adapter.createGame({ seed: 'bet', players: bjPlayers([0, 1], { bet: 100, chips: 0 }), settings });
  assert.equal(broke.round.players[0], null, 'a player with no chips sits the hand out');

  const solo = await connect(host);
  solo.send({ t: 'create', name: 'Solo', settings: { game: 'doudizhu', humanSeats: 1 } });
  await solo.next(S2C.ROOM);
  solo.send({ t: 'bj_bet', amount: 20 });
  assert.match((await solo.next(S2C.ERROR)).message, /no bets/);
  solo.send({ t: 'bj_hit' });
  assert.match((await solo.next(S2C.ERROR)).message, /not part of this game/);
  for (const c of [Alice, Bob, Cara, solo]) c.close();
});

test('a blackjack room with a bot banker settles hands by itself', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice'], { ...bjSettings, humanSeats: 1 });
  const { Alice } = clients;
  Alice.send({ t: 'sit', seat: 2 });
  await Alice.until(S2C.ROOM, (m) => m.room.seats[2].name === 'Alice' && m.room.seats[0].bot);
  autoplayBlackjack(Alice);

  for (let round = 0; round < 4; round++) {
    Alice.send({ t: round === 0 ? 'start' : 'again' });
    const result = await Alice.next(S2C.RESULT, 8_000);
    assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
    assert.equal(result.rows[0].isBanker, true);
    assert.equal(result.rows[0].isBot, true);
    const mine = result.rows.find((row) => row.name === 'Alice');
    assert.equal(mine.seat, 2);
    assert.equal(room.chips.get(ids.Alice), mine.chips);
    for (const row of result.rows.filter((r) => r.isBot)) assert.ok(row.chips >= 0);
  }
  Alice.close();
});

function makeBjRng(seed) {
  let x = seed + 1;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}

test('blackjack settlement pays winners pro rata when the banker cannot cover them, and still sums to zero', () => {
  const adapter = gameAdapter('blackjack');
  let capped = 0;
  for (let n = 0; n < 200 && capped < 3; n++) {
    const players = bjPlayers([0, 1], { bet: 100 });
    const chips = new Map(players.map((p) => [p.id, p.isBot ? 30 : 500]));
    chips.set(players[0].id, 20); // a banker who can cover almost nothing
    const state = adapter.createGame({ seed: `cap-${n}`, players, settings: { pot: 10, startingChips: 1_000 } });
    const rng = makeBjRng(n);
    // Finish the round: bots through the adapter, the human seats with the same stand-at-16 rule the clients use.
    for (let guard = 0; !adapter.isFinished(state) && guard < 200; guard++) {
      if (adapter.isBotTurn(state)) {
        adapter.botTurn(state, rng);
        continue;
      }
      const seat = adapter.seatOnTurn(state);
      const view = adapter.seatView(state, seat);
      if (seat === 0) {
        if (view.you.openable.length) adapter.actions.bj_open(state, 0, { seat: view.you.openable[0] });
        else adapter.actions.bj_hit(state, 0, {});
      } else {
        adapter.actions[view.you.canStand ? 'bj_stand' : 'bj_hit'](state, seat, {});
      }
    }
    assert.ok(adapter.isFinished(state));
    const { frame, changes } = adapter.settle({ state, chips, settings: { startingChips: 1_000 } });
    assert.equal(frame.rows.reduce((sum, row) => sum + row.delta, 0), 0);
    for (const row of frame.rows) assert.ok(row.chips >= 0, 'nobody is charged or paid below zero');
    assert.equal(changes.length, frame.rows.length);
    if (frame.rows[0].capped) capped += 1;
  }
  assert.ok(capped > 0, 'some seeds leave the banker short');
});

test('switching a room to blackjack gives it five seats with the host in the banker box', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients } = await roomOf(host, ['Alice', 'Bob'], { game: 'doudizhu', humanSeats: 2, startingChips: 250, pot: 10 });
  const { Alice, Bob } = clients;

  Alice.send({ t: 'set_game', game: 'blackjack' });
  const switched = (await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'blackjack')).room;
  assert.equal(switched.seats.length, 5);
  assert.equal(switched.seats[0].name, 'Alice');
  assert.equal(switched.seats[1].name, 'Bob');
  assert.equal(switched.settings.pot, potForStack('blackjack', 250));
  assert.equal(switched.phase, 'lobby');

  autoplayBlackjack(Alice);
  autoplayBlackjack(Bob);
  Alice.send({ t: 'start' });
  const view = (await Bob.next(S2C.VIEW)).view;
  assert.equal(view.game, 'blackjack');
  assert.equal(view.seats.length, 4);
  await Alice.next(S2C.RESULT, 8_000);

  Alice.send({ t: 'set_game', game: 'big2' });
  assert.equal((await Alice.until(S2C.ROOM, (m) => m.room.settings.game === 'big2')).room.seats.length, 4);
  Alice.close();
  Bob.close();
});

// --- Malaysian Blackjack: audit fixes ----------------------------------------

/** Plays an adapter-level round out: bots by the adapter, human seats stand at 16, a human banker draws then opens. */
function finishBlackjack(adapter, state, rng) {
  for (let guard = 0; !adapter.isFinished(state) && guard < 300; guard++) {
    if (adapter.isBotTurn(state)) {
      adapter.botTurn(state, rng);
      continue;
    }
    const seat = adapter.seatOnTurn(state);
    const view = adapter.seatView(state, seat);
    if (seat === 0) {
      if (view.you.openable.length) adapter.actions.bj_open(state, 0, { seat: view.you.openable[0] });
      else adapter.actions.bj_hit(state, 0, {});
    } else {
      adapter.actions[view.you.canStand ? 'bj_stand' : 'bj_hit'](state, seat, {});
    }
  }
  assert.ok(adapter.isFinished(state));
}

test('the banker cannot tell an unopened bust seat from an unopened standing one', () => {
  const adapter = gameAdapter('blackjack');
  let checked = 0;
  for (let n = 0; n < 200 && checked < 5; n++) {
    const state = adapter.createGame({ seed: `mask-${n}`, players: bjPlayers([0, 1, 2], { bet: 20 }), settings: { pot: 10, startingChips: 1_000 } });
    const open = state.round.players.filter((p) => p && !p.opened);
    if (state.round.phase !== 'players' || open.length < 2) continue;
    checked += 1;
    open[0].stood = true;
    open[0].busted = false;
    open[1].stood = false;
    open[1].busted = true;
    const view = adapter.seatView(state, 0);
    const [a, b] = [open[0], open[1]].map((p) => view.seats[p.seatIndex]);
    assert.equal(a.stood, true);
    assert.equal(b.stood, true, 'a hidden bust reads as done, same as a stand');
    assert.equal(a.busted, null);
    assert.equal(b.busted, null);
    const strip = ({ seat, name, isBot, bet, count, cards, ...rest }) => rest;
    assert.deepEqual(strip(a), strip(b));
    // Everyone else still sees the real thing.
    assert.equal(adapter.seatView(state, 3).seats[open[1].seatIndex].busted, true);
  }
  assert.ok(checked > 0);
});

test('a player with no chips sits out but still gets a result row', async (t) => {
  const adapter = gameAdapter('blackjack');
  const players = bjPlayers([0, 1], { bet: 20 });
  players[1].chips = 0;
  const state = adapter.createGame({ seed: 'out', players, settings: { pot: 10, startingChips: 1_000 } });
  assert.equal(state.round.players[0], null);
  finishBlackjack(adapter, state, makeBjRng(1));
  const chips = new Map(players.map((p) => [p.id, p.chips]));
  const { frame } = adapter.settle({ state, chips, settings: { startingChips: 1_000 } });
  const out = frame.rows.find((row) => row.seat === 1);
  assert.deepEqual({ ...out }, { seat: 1, name: 'H1', isBot: false, isBanker: false, delta: 0, chips: 0, capped: false, won: false, result: 'out' });
  assert.equal(frame.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.deepEqual(frame.rows.map((row) => row.seat), [0, 1, 2, 3, 4]);

  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob'], bjSettings);
  const { Alice, Bob } = clients;
  room.chips.set(ids.Bob, 0);
  autoplayBlackjack(Alice);
  Alice.send({ t: 'start' });
  const [a, b] = await Promise.all([Alice.next(S2C.RESULT, 8_000), Bob.next(S2C.RESULT, 8_000)]);
  assert.equal(a.rows.find((row) => row.name === 'Bob').result, 'out');
  assert.deepEqual(a.rows, b.rows);
  Alice.send({ t: 'again' });
  await Alice.next(S2C.RESULT, 8_000);
  Alice.close();
  Bob.close();
});

test('a stored bet below the table minimum is dealt at the minimum, or at the purse when that is smaller', () => {
  const adapter = gameAdapter('blackjack');
  const settings = { pot: 10, startingChips: 1_000 };
  const flush = adapter.createGame({ seed: 'floor', players: bjPlayers([0, 1], { bet: 3, chips: 400 }), settings });
  assert.equal(flush.round.players[0].bet, 10);
  const short = adapter.createGame({ seed: 'floor', players: bjPlayers([0, 1], { bet: 3, chips: 4 }), settings });
  assert.equal(short.round.players[0].bet, 4);
  const shorter = adapter.createGame({ seed: 'floor', players: bjPlayers([0, 1], { bet: 50, chips: 6 }), settings });
  assert.equal(shorter.round.players[0].bet, 6);
});

test('a dropped player on an opening 15 against a banker special runs instead of hitting', () => {
  const adapter = gameAdapter('blackjack');
  let found = 0;
  for (let n = 0; n < 40_000 && found < 2; n++) {
    const state = adapter.createGame({ seed: `run-${n}`, players: bjPlayers([0, 1], { bet: 20 }), settings: { pot: 10, startingChips: 1_000 } });
    const seat = state.round.players[0];
    if (!seat?.bankerSpecialPending || state.round.activeSeat !== 0) continue;
    found += 1;
    adapter.toBot(state.players[1], null, 'H1 (bot)');
    assert.equal(adapter.isBotTurn(state), true);
    const acted = adapter.botTurn(state, makeBjRng(n));
    assert.deepEqual({ seat: acted.seat, kind: acted.kind }, { seat: 1, kind: 'run' });
    assert.equal(seat.result, 'run');
    assert.equal(seat.payout, 0);
    assert.equal(seat.bankerSpecialPending, false);
  }
  assert.ok(found > 0, 'some seeds deal a human an opening 15 against a banker special');
});

test('a seat dealt to a bot stays a bot when its member comes back', async (t) => {
  const adapter = gameAdapter('blackjack');
  const state = adapter.createGame({ seed: 'dealt', players: bjPlayers([0]), settings: { pot: 10, startingChips: 1_000 } });
  adapter.toHuman(state.players[1], 'member-1', 'Bob');
  assert.deepEqual({ id: state.players[1].id, isBot: state.players[1].isBot }, { id: 'bot-1', isBot: true });
  adapter.toBot(state.players[1], null, 'Bob (bot)');
  assert.equal(state.players[1].name, 'B1', 'a house bot is not renamed after a member who never held the seat');
  const human = adapter.createGame({ seed: 'dealt', players: bjPlayers([0, 1]), settings: { pot: 10, startingChips: 1_000 } });
  adapter.toBot(human.players[1], null, 'H1 (bot)');
  assert.equal(human.players[1].isBot, true);
  adapter.toHuman(human.players[1], 'human-1', 'H1');
  assert.equal(human.players[1].isBot, false, 'a seat dealt to a person still returns to them');

  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, code, room } = await roomOf(host, ['Alice', 'Bob'], bjSettings);
  const { Alice, Bob } = clients;
  const token = room.members.get(ids.Bob).token;
  Bob.close();
  await waitFor(() => !room.members.get(ids.Bob).connected);
  autoplayBlackjack(Alice);
  Alice.send({ t: 'start' });
  await waitFor(() => room.state);
  assert.equal(room.state.players[1].dealtHuman, false);
  const back = await connect(host);
  back.send({ t: 'resume', code, token });
  await back.next(S2C.ROOM);
  assert.equal(room.state.players[1].isBot, true, 'the member waits for the next deal');
  assert.match(room.state.players[1].id, /^bot-/);
  const result = await Alice.next(S2C.RESULT, 8_000);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(room.chips.get(ids.Bob), 1_000, 'the absent member\'s purse is untouched');
  Alice.close();
  back.close();
});

test('a blackjack bet is dropped when its owner leaves', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, room } = await roomOf(host, ['Alice', 'Bob', 'Cara'], { ...bjSettings, humanSeats: 3 });
  const { Alice, Bob, Cara } = clients;
  Bob.send({ t: 'bj_bet', amount: 50 });
  Cara.send({ t: 'bj_bet', amount: 30 });
  await waitFor(() => room.bets.get(ids.Bob) === 50 && room.bets.get(ids.Cara) === 30);

  Bob.send({ t: 'leave' });
  await waitFor(() => !room.members.has(ids.Bob));
  assert.equal(room.bets.has(ids.Bob), false, 'leaving between hands');

  Alice.send({ t: 'start' });
  await Cara.next(S2C.VIEW);
  Cara.send({ t: 'leave' });
  await waitFor(() => !room.members.has(ids.Cara));
  assert.equal(room.bets.has(ids.Cara), false, 'leaving mid-hand');
  Alice.close();
});

test('a member who resumes into a seat dealt to a bot cannot play it, and the hand still settles', async (t) => {
  const host = await startHub();
  t.after(() => host.stop());
  const { clients, ids, code, room } = await roomOf(host, ['Alice', 'Bob'], bjSettings);
  const { Alice, Bob } = clients;
  const token = room.members.get(ids.Bob).token;
  Bob.close();
  await waitFor(() => !room.members.get(ids.Bob).connected);

  Alice.send({ t: 'start' });
  await waitFor(() => room.state);
  const back = await connect(host);
  const views = [];
  back.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.t === S2C.VIEW) views.push(message.view);
  });
  back.send({ t: 'resume', code, token });
  await back.next(S2C.ROOM);
  assert.equal(room.state.players[1].isBot, true);

  for (const t of ['bj_hit', 'bj_stand', 'bj_run']) {
    back.send({ t });
    assert.match((await back.next(S2C.ERROR)).message, /a bot is playing your seat/);
  }
  back.send({ t: 'bj_open', seat: 2 });
  assert.match((await back.next(S2C.ERROR)).message, /a bot is playing your seat/);

  autoplayBlackjack(Alice);
  const result = await Alice.next(S2C.RESULT, 8_000);
  assert.equal(result.rows.reduce((sum, row) => sum + row.delta, 0), 0);
  assert.equal(result.rows.some((row) => row.name === 'Bob'), false, 'the bot played the seat under its own name');
  assert.equal(room.chips.get(ids.Bob), 1_000);
  assert.ok(views.length > 0);
  for (const view of views) {
    assert.deepEqual(view.you, { canRun: false, canHit: false, canStand: false, canBankerHit: false, openable: [] });
  }
  Alice.close();
  back.close();
});
