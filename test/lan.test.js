import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { WsConnection, acceptKey, attachWebSocket } from '../server/ws.js';
import { RoomHub } from '../server/rooms.js';
import { gameAdapter } from '../server/games.js';
import { C2S, S2C } from '../src/net/protocol.js';
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

test('a newcomer can join between hands but not during one', async (t) => {
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
  assert.match((await carol.next(S2C.ERROR)).message, /still being played/);

  autopilot(alice);
  autopilot(bob);
  await alice.next(S2C.RESULT, 20_000);

  carol.send({ t: 'join', code, name: 'Carol' });
  const joined = await carol.next(S2C.ROOM);
  assert.equal(joined.room.phase, 'finished');
  assert.equal(joined.room.seats[2].name, 'Carol');
  assert.equal(typeof joined.token, 'string');
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
  assert.match((await dave.next(S2C.ERROR)).message, /full/);

  bob.close();
  await alice.until(S2C.ROOM, (m) => m.room.seats[1].connected === false);
  dave.send({ t: 'join', code, name: 'Dave' });
  const taken = await dave.next(S2C.ROOM);
  assert.equal(taken.room.seats[1].name, 'Dave');

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

test('humanSeats clamps to the seats the game has, and the game cannot change after create', async (t) => {
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
