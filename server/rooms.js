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
import { C2S, S2C, encode, sanitiseSettings } from '../src/net/protocol.js';
import { generateCode } from '../src/net/roomcode.js';

const SEATS = 3;
const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui'];
const BOT_STEP_MS = 700;
// Clients run a 3-4.5s deal animation; a bot that bids inside it acts on cards
// the player has not seen yet.
const DEAL_GRACE_MS = 3_800;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
// A dropped player's seat is held for a resume, but not for ever: a room that
// is never full would otherwise keep a ghost in it until someone evicts it.
const HELD_SEAT_TTL_MS = 10 * 60 * 1000;

export class RoomHub {
  /** @param {{advertisedHost?: string, port?: number, botStepMs?: number, dealGraceMs?: number, heldSeatTtlMs?: number}} [options] */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    this.options = {
      botStepMs: BOT_STEP_MS,
      dealGraceMs: DEAL_GRACE_MS,
      heldSeatTtlMs: HELD_SEAT_TTL_MS,
      ...options,
    };
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

  fail(conn, message, code) {
    conn.sendJson(code ? { t: S2C.ERROR, message, code } : { t: S2C.ERROR, message });
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
      case C2S.RESUME: return this.resume(conn, message);
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
      // Chips of players who left, by lower-cased name, so leaving between hands
      // and coming back neither wipes a stack nor hands out a fresh one.
      departed: new Map(),
      handNo: 0,
      dealKey: null,
      graceUntil: 0,
      lastResult: null,
    };
    this.rooms.set(code, room);
    const member = this.seat(room, conn, message.name);
    this.sendRoom(room, member, { code });
    this.broadcastRoom(room);
  }

  join(conn, message) {
    const code = String(message.code ?? '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.fail(conn, `no room with the code ${code}`);
    if (room.phase === 'playing') return this.fail(conn, 'that hand is still being played — join when it ends');
    // Leave the old seat first: a player re-joining the room they already fill
    // frees their own seat, so it must not count against capacity or evict a ghost.
    if (conn.data.room) this.disconnect(conn, true);
    // A member who dropped still holds a seat for a resume, so they count here.
    // The longest-gone one is the first to lose theirs to a newcomer.
    let evict = null;
    if (room.members.size >= room.settings.humanSeats) {
      for (const m of room.members.values()) {
        if (!m.connected && (!evict || m.disconnectedAt < evict.disconnectedAt)) evict = m;
      }
      if (!evict) return this.fail(conn, 'that room is full');
    }
    if (evict && room.members.has(evict.id)) {
      this.releaseSeat(room, evict);
    }
    const member = this.seat(room, conn, message.name);
    // Nobody connected is left to run the room if the host's seat was just evicted.
    const host = room.members.get(room.hostId);
    if (!host || !host.connected) room.hostId = member.id;
    delete room.emptySince;
    this.sendRoom(room, member, { code });
    this.broadcastRoom(room);
    return undefined;
  }

  seat(room, conn, rawName) {
    const seat = room.seats.findIndex((s) => s === null);
    const name = cleanName(rawName) || `Player ${seat + 1}`;
    // The member id stays fixed for the life of the seat; conn.id changes with
    // every reconnect, so lookups go through conn.data.member instead.
    const member = {
      id: conn.id,
      name,
      seat,
      conn,
      connected: true,
      token: randomBytes(12).toString('hex'),
    };
    room.seats[seat] = member.id;
    room.members.set(member.id, member);
    const key = name.toLowerCase();
    room.chips.set(member.id, room.departed.get(key) ?? room.settings.startingChips);
    room.departed.delete(key);
    conn.data.room = room.code;
    conn.data.seat = seat;
    conn.data.member = member.id;
    room.lastActivity = Date.now();
    return member;
  }

  updateSettings(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can change the settings');
    if (room.phase !== 'lobby') return this.fail(conn, 'the settings are locked once a hand is dealt');
    room.settings = sanitiseSettings({ ...room.settings, ...message.settings });
    for (const id of room.chips.keys()) room.chips.set(id, room.settings.startingChips);
    room.departed.clear(); // a new starting stack resets everyone, including those away
    this.broadcastRoom(room);
    return undefined;
  }

  setHumanSeats(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can change the seats');
    if (room.phase !== 'lobby') return this.fail(conn, 'the seats are locked once a hand is dealt');
    const wanted = Math.min(SEATS, Math.max(room.members.size, Math.round(Number(message.humanSeats) || 1)));
    room.settings.humanSeats = wanted;
    this.broadcastRoom(room);
    return undefined;
  }

  // --- play ------------------------------------------------------------------

  start(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can start the hand');
    if (room.phase === 'playing') return this.fail(conn, 'the hand is already running');
    this.deal(room);
    return undefined;
  }

  again(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can deal again');
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
        const name = spare.pop() ?? 'Bot';
        players.push({ id: `bot-${seat}`, name, isBot: true, skill });
        if (!room.chips.has(`bot-${seat}`)) room.chips.set(`bot-${seat}`, room.settings.startingChips);
      }
    }
    const seed = randomBytes(8).toString('hex');
    room.state = createGame({ seed, players, baseMultiplier: room.settings.baseMultiplier });
    room.rng = makeRng(`${seed}:bots`);
    room.phase = 'playing';
    room.handNo += 1;
    room.lastResult = null;
    room.lastActivity = Date.now();
    this.broadcastRoom(room);
    this.broadcastViews(room);
    this.scheduleBots(room);
  }

  action(conn, apply) {
    const room = this.roomOf(conn);
    if (room.phase !== 'playing' || !room.state) return this.fail(conn, 'no hand is running');
    const member = room.members.get(conn.data.member);
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
    // Fresh cards (a new hand, or the engine's redeal after three passes) get the
    // deal animation's worth of quiet before the first bot moves. The deadline is
    // stored, not just applied once, so a drop or resume inside the grace (which
    // reschedules) cannot cut it short.
    const dealKey = `${room.handNo}:${room.state.deal}`;
    if (dealKey !== room.dealKey) room.graceUntil = Date.now() + this.options.dealGraceMs;
    room.dealKey = dealKey;
    const seat = room.state.phase === Phase.BIDDING ? room.state.bidding.turn : room.state.turn;
    if (!room.state.players[seat]?.isBot) return;
    const delay = Math.max(this.options.botStepMs, (room.graceUntil ?? 0) - Date.now());
    room.botTimer = setTimeout(() => {
      if (!this.rooms.has(room.code) || !room.state) return;
      const acted = botTurn(room.state, room.rng);
      if (acted) this.describeLastAction(room, acted.seat, acted);
      this.afterAction(room);
    }, delay);
  }

  /**
   * Only bidding is broadcast as a spoken bubble. Plays and passes travel in the
   * seat view as trickPlays and land on the felt in front of the seat that made
   * them, which says who moved without a caption.
   */
  describeLastAction(room, seat, acted) {
    const last = room.state.log[room.state.log.length - 1];
    if (acted?.kind !== 'bid' && last?.kind !== 'bid') return;
    const value = acted?.value ?? last.value;
    this.broadcast(room, { t: S2C.EVENT, kind: 'say', seat, text: value === 0 ? 'No call' : `${value}` });
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
    // Someone who left mid-hand kept their purse keyed by member id so this
    // settlement could pay it; now that it has, file it under their name so a
    // rejoin finds it. Real bots carry no " (bot)" suffix and are left alone.
    for (const player of room.state.players) {
      if (room.members.has(player.id) || !room.chips.has(player.id) || !BOT_SUFFIX.test(player.name)) continue;
      this.stash(room, player.name.replace(BOT_SUFFIX, ''), room.chips.get(player.id));
      room.chips.delete(player.id);
    }
    room.phase = 'finished';
    // result.multiplier already carries the room's base factor — the engine was
    // created with it — so there is no floor left to apply here.
    // Kept so a player who resumes after the hand ended still sees the result.
    room.lastResult = { t: S2C.RESULT, result, rows, multiplier: result.multiplier };
    this.broadcast(room, room.lastResult);
    this.broadcastRoom(room);
  }

  chat(conn, message) {
    const room = this.roomOf(conn);
    const member = room.members.get(conn.data.member);
    const text = String(message.text ?? '').slice(0, 200);
    if (!text.trim()) return;
    this.broadcast(room, { t: S2C.CHAT, from: member?.name ?? 'Someone', text });
  }

  // --- disconnects -----------------------------------------------------------

  /**
   * @param {boolean} explicit true when the player chose to go (LEAVE, or moving to
   *   another room). A plain drop keeps the seat so the same player can resume.
   */
  disconnect(conn, explicit = false) {
    const code = conn.data.room;
    conn.data.room = null;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) return;
    const member = room.members.get(conn.data.member);
    // A connection a resume already replaced closes later; it must not undo that.
    if (!member || member.conn !== conn) return;

    const playing = room.phase === 'playing' && room.state;
    member.connected = false;
    if (playing) {
      // Hand the seat to a bot so the table does not wedge mid-hand.
      const player = room.state.players[member.seat];
      player.isBot = true;
      player.skill = skillByName(room.settings.botSkill);
      player.name = `${member.name} (bot)`;
      this.broadcast(room, { t: S2C.EVENT, kind: 'left', seat: member.seat, name: member.name });
      this.scheduleBots(room);
    }
    if (explicit) {
      // state.players[seat].id still names this member, so a running hand settles
      // into the right purse (settle() then files it under their name); only the
      // seat itself is freed.
      if (playing) {
        room.members.delete(member.id);
        room.seats[member.seat] = null;
      } else {
        this.releaseSeat(room, member);
      }
    } else {
      member.disconnectedAt = Date.now();
    }

    if ([...room.members.values()].every((m) => !m.connected)) {
      clearTimeout(room.botTimer);
      room.emptySince = Date.now();
    }
    this.reassignHost(room);
    this.broadcastRoom(room);
    this.broadcastViews(room);
  }

  /** Take back a seat that was held after a drop, using the token from its ROOM frame. */
  resume(conn, message) {
    const room = this.rooms.get(String(message.code ?? '').toUpperCase());
    const token = String(message.token ?? '');
    const member = room && token ? [...room.members.values()].find((m) => m.token === token) : null;
    if (!room || !member) return this.fail(conn, 'that seat is no longer held', 'resume_failed');

    if (conn.data.room && (conn.data.room !== room.code || conn.data.member !== member.id)) {
      this.disconnect(conn, true);
    }
    if (member.connected && member.conn !== conn) {
      // The old socket may be a half-dead one the heartbeat has not caught yet.
      member.conn.data.room = null;
      member.conn.close(4000, 'replaced');
    }
    member.conn = conn;
    member.connected = true;
    // If everyone else dropped, or the host left while this member was away, the
    // room has no connected host; whoever is back first takes it.
    const host = room.members.get(room.hostId);
    if (!host || !host.connected) room.hostId = member.id;
    delete member.disconnectedAt;
    delete room.emptySince;
    conn.data.room = room.code;
    conn.data.seat = member.seat;
    conn.data.member = member.id;
    room.seats[member.seat] = member.id;
    room.lastActivity = Date.now();

    const playing = room.phase === 'playing' && room.state;
    // After a hand, the seat may have been handed to a newcomer; the previous
    // holder's cards and result are not theirs to see.
    const holdsHand = room.state?.players[member.seat]?.id === member.id;
    this.sendRoom(room, member, { code: room.code });
    if (playing) {
      // The hand may have been dealt while they were away, with a bot id in the
      // seat; settle() pays the purse named by player.id, so put theirs back.
      const player = room.state.players[member.seat];
      player.isBot = false;
      player.id = member.id;
      player.name = member.name;
      this.broadcast(room, { t: S2C.EVENT, kind: 'back', seat: member.seat, name: member.name });
      // The seat is human again, so this cancels a pending bot move rather than
      // letting the bot take the turn the player just came back to.
      this.scheduleBots(room);
      this.broadcastViews(room);
    } else if (holdsHand) {
      this.sendView(room, member);
    }
    if (room.phase === 'finished' && room.lastResult && holdsHand) member.conn.sendJson(room.lastResult);
    this.broadcastRoom(room);
    return undefined;
  }

  /** Free a member's seat outside a running hand, keeping their chips for a rejoin. */
  releaseSeat(room, member) {
    room.members.delete(member.id);
    room.seats[member.seat] = null;
    this.stash(room, member.name, room.chips.get(member.id));
    room.chips.delete(member.id);
  }

  stash(room, name, chips) {
    if (chips === undefined) return;
    const key = name.toLowerCase();
    room.departed.set(key, (room.departed.get(key) ?? 0) + chips);
  }

  /** Keep the host pointing at someone who can deal; a connected member wins. */
  reassignHost(room) {
    const host = room.members.get(room.hostId);
    if (host?.connected) return;
    const connected = [...room.members.values()].find((m) => m.connected);
    if (connected) room.hostId = connected.id;
    else if (!host) {
      // Nobody is connected and the host's seat is gone; name a held member so
      // hostId never points at nobody. resume() re-checks when someone returns.
      const any = room.members.values().next().value;
      if (any) room.hostId = any.id;
    }
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.phase !== 'playing') {
        let changed = false;
        for (const m of [...room.members.values()]) {
          if (m.connected || m.disconnectedAt === undefined) continue;
          if (now - m.disconnectedAt > this.options.heldSeatTtlMs) {
            this.releaseSeat(room, m);
            changed = true;
          }
        }
        if (changed) {
          this.reassignHost(room);
          this.broadcastRoom(room);
        }
      }
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

  /** The token is the member's own secret: it goes to them and into no shared frame. */
  sendRoom(room, member, extra = {}) {
    member.conn.sendJson({ t: S2C.ROOM, room: this.describe(room), you: member.id, token: member.token, ...extra });
  }

  broadcastRoom(room) {
    for (const member of room.members.values()) {
      if (member.connected) this.sendRoom(room, member);
    }
  }

  sendView(room, member) {
    // `hand` lets the client tell hand 2 from hand 1; state.deal restarts at 0 each hand.
    member.conn.sendJson({ t: S2C.VIEW, view: seatView(room.state, member.seat), hand: room.handNo });
  }

  broadcastViews(room) {
    if (!room.state) return;
    for (const member of room.members.values()) {
      if (member.connected) this.sendView(room, member);
    }
  }
}

const BOT_SUFFIX = / \(bot\)$/;

function cleanName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 18);
}
