/**
 * Rooms for local network play.
 *
 * The host is authoritative. It deals, it runs the bots, it validates every
 * action against the same rules module the browser uses, and it sends each seat
 * a view containing only that seat's hand. A client cannot read another player's
 * cards out of the traffic, and cannot play a card it does not hold.
 *
 * Chips here are room chips, handed out by the host's settings. They are
 * deliberately separate from the single-player purse: a friend setting the
 * starting stack to ten million should not move anybody's solo bankroll.
 */

import { randomBytes } from 'node:crypto';
import { makeRng } from '../src/core/rng.js';
import { settleDouDiZhu } from '../src/core/economy.js';
import { Phase, bid, createGame, pass, play, seatView } from '../src/games/doudizhu/engine.js';
import { botTurn } from '../src/games/doudizhu/match.js';
import { skillByName } from '../src/games/doudizhu/ai.js';
import { describeCombo } from '../src/games/doudizhu/rules.js';
import { C2S, S2C, encode, sanitiseSettings } from '../src/net/protocol.js';
import { generateCode } from '../src/net/roomcode.js';

const SEATS = 3;
const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui'];
const BOT_STEP_MS = 700;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

export class RoomHub {
  /** @param {{advertisedHost?: string, port?: number, botStepMs?: number}} [options] */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    this.options = { botStepMs: BOT_STEP_MS, ...options };
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  close() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) clearTimeout(room.botTimer);
  }

  attach(conn) {
    conn.sendJson({ t: S2C.WELCOME, id: conn.id, host: this.options.advertisedHost, port: this.options.port });
    conn.on('message', (text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return this.fail(conn, 'that was not valid JSON');
      }
      if (!message || typeof message.t !== 'string') return this.fail(conn, 'malformed message');
      try {
        this.handle(conn, message);
      } catch (error) {
        this.fail(conn, error.message ?? 'something went wrong');
      }
      return undefined;
    });
    conn.on('close', () => this.disconnect(conn));
    // A reset from a client that vanished is normal; the seat is handled by the
    // close that follows, and nothing about it should reach the console.
    conn.on('error', () => {});
  }

  fail(conn, message) {
    conn.sendJson({ t: S2C.ERROR, message });
  }

  handle(conn, message) {
    switch (message.t) {
      case C2S.CREATE: return this.create(conn, message);
      case C2S.JOIN: return this.join(conn, message);
      case C2S.SETTINGS: return this.updateSettings(conn, message);
      case C2S.SEAT_FILL: return this.setHumanSeats(conn, message);
      case C2S.START: return this.start(conn);
      case C2S.AGAIN: return this.again(conn);
      case C2S.BID: return this.action(conn, (room, seat) => bid(room.state, seat, Number(message.value)));
      case C2S.PLAY: return this.action(conn, (room, seat) => play(room.state, seat, message.cards ?? []));
      case C2S.PASS: return this.action(conn, (room, seat) => pass(room.state, seat));
      case C2S.CHAT: return this.chat(conn, message);
      case C2S.LEAVE: return this.disconnect(conn, true);
      default: return this.fail(conn, `unknown message "${message.t}"`);
    }
  }

  // --- room lifecycle --------------------------------------------------------

  create(conn, message) {
    if (conn.data.room) this.disconnect(conn, true);
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode();
    const settings = sanitiseSettings(message.settings);
    const room = {
      code,
      hostId: conn.id,
      settings,
      members: new Map(),
      seats: new Array(SEATS).fill(null),
      state: null,
      phase: 'lobby',
      botTimer: null,
      lastActivity: Date.now(),
      chips: new Map(),
    };
    this.rooms.set(code, room);
    this.seat(room, conn, message.name);
    conn.sendJson({ t: S2C.ROOM, room: this.describe(room), you: conn.id, code });
    this.broadcastRoom(room);
  }

  join(conn, message) {
    const code = String(message.code ?? '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.fail(conn, `no room with the code ${code}`);
    if (room.phase !== 'lobby') return this.fail(conn, 'that game has already started');
    const taken = room.seats.filter(Boolean).length;
    if (taken >= room.settings.humanSeats) return this.fail(conn, 'that room is full');
    if (conn.data.room) this.disconnect(conn, true);
    this.seat(room, conn, message.name);
    conn.sendJson({ t: S2C.ROOM, room: this.describe(room), you: conn.id, code });
    this.broadcastRoom(room);
    return undefined;
  }

  seat(room, conn, rawName) {
    const seat = room.seats.findIndex((s) => s === null);
    const name = cleanName(rawName) || `Player ${seat + 1}`;
    room.seats[seat] = conn.id;
    room.members.set(conn.id, { id: conn.id, name, seat, conn, connected: true });
    room.chips.set(conn.id, room.settings.startingChips);
    conn.data.room = room.code;
    conn.data.seat = seat;
    room.lastActivity = Date.now();
  }

  updateSettings(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.id) return this.fail(conn, 'only the room host can change the settings');
    if (room.phase !== 'lobby') return this.fail(conn, 'the settings are locked once a hand is dealt');
    room.settings = sanitiseSettings({ ...room.settings, ...message.settings });
    for (const id of room.chips.keys()) room.chips.set(id, room.settings.startingChips);
    this.broadcastRoom(room);
    return undefined;
  }

  setHumanSeats(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.id) return this.fail(conn, 'only the room host can change the seats');
    if (room.phase !== 'lobby') return this.fail(conn, 'the seats are locked once a hand is dealt');
    const wanted = Math.min(SEATS, Math.max(room.members.size, Math.round(Number(message.humanSeats) || 1)));
    room.settings.humanSeats = wanted;
    this.broadcastRoom(room);
    return undefined;
  }

  // --- play ------------------------------------------------------------------

  start(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.id) return this.fail(conn, 'only the room host can start the hand');
    if (room.phase === 'playing') return this.fail(conn, 'the hand is already running');
    this.deal(room);
    return undefined;
  }

  again(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.id) return this.fail(conn, 'only the room host can deal again');
    this.deal(room);
    return undefined;
  }

  deal(room) {
    clearTimeout(room.botTimer);
    const skill = skillByName(room.settings.botSkill);
    const spare = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const players = [];
    for (let seat = 0; seat < SEATS; seat++) {
      const memberId = room.seats[seat];
      const member = memberId ? room.members.get(memberId) : null;
      if (member && member.connected) {
        players.push({ id: member.id, name: member.name, isBot: false });
      } else {
        const name = `${spare.pop() ?? 'Bot'} (${skill.name})`;
        players.push({ id: `bot-${seat}`, name, isBot: true, skill });
        if (!room.chips.has(`bot-${seat}`)) room.chips.set(`bot-${seat}`, room.settings.startingChips);
      }
    }
    const seed = randomBytes(8).toString('hex');
    room.state = createGame({ seed, players });
    room.rng = makeRng(`${seed}:bots`);
    room.phase = 'playing';
    room.lastActivity = Date.now();
    this.broadcastRoom(room);
    this.broadcastViews(room);
    this.scheduleBots(room);
  }

  action(conn, apply) {
    const room = this.roomOf(conn);
    if (room.phase !== 'playing' || !room.state) return this.fail(conn, 'no hand is running');
    const member = room.members.get(conn.id);
    if (!member) return this.fail(conn, 'you are not seated');
    const result = apply(room, member.seat);
    if (!result?.ok) return this.fail(conn, result?.error ?? 'that move was refused');
    this.describeLastAction(room, member.seat);
    room.lastActivity = Date.now();
    this.afterAction(room);
    return undefined;
  }

  afterAction(room) {
    this.broadcastViews(room);
    if (room.state.phase === Phase.FINISHED) this.settle(room);
    else this.scheduleBots(room);
  }

  scheduleBots(room) {
    clearTimeout(room.botTimer);
    if (!room.state || room.state.phase === Phase.FINISHED) return;
    const seat = room.state.phase === Phase.BIDDING ? room.state.bidding.turn : room.state.turn;
    if (!room.state.players[seat]?.isBot) return;
    room.botTimer = setTimeout(() => {
      if (!this.rooms.has(room.code) || !room.state) return;
      const acted = botTurn(room.state, room.rng);
      if (acted) this.describeLastAction(room, acted.seat, acted);
      this.afterAction(room);
    }, this.options.botStepMs);
  }

  describeLastAction(room, seat, acted) {
    const last = room.state.log[room.state.log.length - 1];
    let text = '';
    if (acted?.kind === 'bid' || last?.kind === 'bid') {
      const value = acted?.value ?? last.value;
      text = value === 0 ? 'No call' : `${value} point${value > 1 ? 's' : ''}`;
    } else if (last?.kind === 'pass') {
      text = 'Pass';
    } else if (last?.kind === 'play') {
      text = describeCombo(last.combo);
    }
    if (text) this.broadcast(room, { t: S2C.EVENT, kind: 'say', seat, text });
  }

  settle(room) {
    const result = room.state.result;
    const lobby = {
      pot: room.settings.pot,
      baseMultiplier: room.settings.baseMultiplier,
      capFactor: room.settings.capFactor,
      rescue: false,
    };
    // Work out what the losers actually pay after their caps, then hand exactly
    // that much to the winning side. Against bots a cap can leave the winner
    // "owed" chips nobody paid; between real players it cannot, or the room
    // would mint chips every capped hand.
    const rows = [];
    const losers = [];
    const winners = [];
    for (let seat = 0; seat < SEATS; seat++) {
      const player = room.state.players[seat];
      const bankroll = room.chips.get(player.id) ?? room.settings.startingChips;
      const settlement = settleDouDiZhu({ lobby, result, seat, bankroll });
      const row = {
        seat,
        name: player.name,
        isBot: player.isBot,
        delta: settlement.delta,
        capped: settlement.capped,
        won: settlement.won,
        bankroll,
      };
      rows.push(row);
      (settlement.won ? winners : losers).push(row);
    }

    const pot = losers.reduce((sum, row) => sum + Math.abs(row.delta), 0);
    const totalClaimed = winners.reduce((sum, row) => sum + row.delta, 0);
    if (totalClaimed > 0) {
      let handedOut = 0;
      winners.forEach((row, index) => {
        const share = index === winners.length - 1
          ? pot - handedOut                                   // the last seat takes the remainder
          : Math.floor((pot * row.delta) / totalClaimed);     // otherwise pro rata
        handedOut += share;
        row.capped = row.capped || share !== row.delta;
        row.delta = share;
      });
    }

    for (const row of rows) {
      const player = room.state.players[row.seat];
      room.chips.set(player.id, Math.max(0, row.bankroll + row.delta));
      row.chips = room.chips.get(player.id);
      delete row.bankroll;
    }
    room.phase = 'finished';
    this.broadcast(room, { t: S2C.RESULT, result, rows, multiplier: Math.max(result.multiplier, room.settings.baseMultiplier) });
    this.broadcastRoom(room);
  }

  chat(conn, message) {
    const room = this.roomOf(conn);
    const member = room.members.get(conn.id);
    const text = String(message.text ?? '').slice(0, 200);
    if (!text.trim()) return;
    this.broadcast(room, { t: S2C.CHAT, from: member?.name ?? 'Someone', text });
  }

  // --- disconnects -----------------------------------------------------------

  disconnect(conn, silent = false) {
    const code = conn.data.room;
    if (!code) return;
    const room = this.rooms.get(code);
    conn.data.room = null;
    if (!room) return;
    const member = room.members.get(conn.id);
    if (!member) return;

    if (room.phase === 'playing' && room.state) {
      // Hand the seat to a bot so the table does not wedge mid-hand.
      member.connected = false;
      const player = room.state.players[member.seat];
      player.isBot = true;
      player.skill = skillByName(room.settings.botSkill);
      player.name = `${member.name} (bot)`;
      this.broadcast(room, { t: S2C.EVENT, kind: 'left', seat: member.seat, name: member.name });
      this.scheduleBots(room);
    } else {
      room.members.delete(conn.id);
      room.seats[member.seat] = null;
    }

    if ([...room.members.values()].every((m) => !m.connected)) {
      clearTimeout(room.botTimer);
      room.emptySince = Date.now();
    } else if (room.hostId === conn.id) {
      const next = [...room.members.values()].find((m) => m.connected);
      if (next) room.hostId = next.id;
    }
    if (!silent) this.broadcastRoom(room);
    this.broadcastViews(room);
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const empty = [...room.members.values()].every((m) => !m.connected);
      if (empty && now - (room.emptySince ?? room.lastActivity) > EMPTY_ROOM_TTL_MS) {
        clearTimeout(room.botTimer);
        this.rooms.delete(code);
      }
    }
  }

  // --- broadcasting ----------------------------------------------------------

  roomOf(conn) {
    const room = this.rooms.get(conn.data.room);
    if (!room) throw new Error('you are not in a room');
    return room;
  }

  describe(room) {
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      seats: room.seats.map((id, seat) => {
        const member = id ? room.members.get(id) : null;
        return {
          seat,
          id: id ?? null,
          name: member?.name ?? null,
          connected: !!member?.connected,
          isHost: id === room.hostId,
          chips: id ? room.chips.get(id) ?? room.settings.startingChips : null,
          bot: seat >= room.settings.humanSeats || !member,
        };
      }),
    };
  }

  broadcast(room, message) {
    const text = encode(message);
    for (const member of room.members.values()) {
      if (member.connected) member.conn.send(text);
    }
  }

  broadcastRoom(room) {
    for (const member of room.members.values()) {
      if (member.connected) member.conn.sendJson({ t: S2C.ROOM, room: this.describe(room), you: member.id });
    }
  }

  broadcastViews(room) {
    if (!room.state) return;
    for (const member of room.members.values()) {
      if (member.connected) member.conn.sendJson({ t: S2C.VIEW, view: seatView(room.state, member.seat) });
    }
  }
}

function cleanName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 18);
}
