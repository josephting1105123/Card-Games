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
import { BIG2_MIN_STACK, C2S, MAX_MEMBERS, S2C, SEATS_BY_GAME, encode, potForStack, sanitiseSettings } from '../src/net/protocol.js';
import { generateCode } from '../src/net/roomcode.js';
import { gameAdapter } from './games.js';

const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui'];
const BOT_STEP_MS = 700;
// Clients run a 3-4.5s deal animation; a bot that bids inside it acts on cards
// the player has not seen yet.
const DEAL_GRACE_MS = 3_800;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
// A dropped player's seat is held for a resume, but not for ever: a room that
// is never full would otherwise keep a ghost in it until someone evicts it.
const HELD_SEAT_TTL_MS = 10 * 60 * 1000;
const MAX_ROOMS = 300;
// One connection could otherwise fill the whole server with lobbies nobody uses.
const MAX_ROOMS_PER_IP = 3;
// Failed code lookups before a connection is cut off: a guessing script gets a few tries.
const MAX_LOOKUP_MISSES = 5;
// Chips kept for players who left; a room that churns names must not grow this without bound.
const MAX_DEPARTED = 32;
const LIMIT_LOG_INTERVAL_MS = 60_000;

export class RoomHub {
  /** @param {{advertisedHost?: string, port?: number, public?: boolean, maxRooms?: number, maxRoomsPerIp?: number, botStepMs?: number, dealGraceMs?: number, heldSeatTtlMs?: number, log?: (text: string) => void}} [options] */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.rooms = new Map();
    this.options = {
      botStepMs: BOT_STEP_MS,
      dealGraceMs: DEAL_GRACE_MS,
      heldSeatTtlMs: HELD_SEAT_TTL_MS,
      maxRooms: MAX_ROOMS,
      maxRoomsPerIp: MAX_ROOMS_PER_IP,
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
    // A public server has no LAN address worth showing, so clients never see one.
    const isPublic = !!this.options.public;
    conn.sendJson({
      t: S2C.WELCOME,
      id: conn.id,
      host: isPublic ? null : this.options.advertisedHost,
      port: this.options.port,
      public: isPublic,
    });
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
    conn.on('close', () => {
      const code = conn.data.room;
      try {
        this.disconnect(conn);
      } catch (error) {
        this.isolate(this.rooms.get(code), error);
      }
    });
    // A reset from a client that vanished is normal; the seat is handled by the
    // close that follows, and nothing about it should reach the console.
    conn.on('error', () => {});
  }

  /** One line a minute at most: a flood hitting a limit must not become a flood of log lines. */
  logLimit(text) {
    const now = Date.now();
    if (now - (this.lastLimitLog ?? 0) < LIMIT_LOG_INTERVAL_MS) return;
    this.lastLimitLog = now;
    (this.options.log ?? console.warn)(text);
  }

  fail(conn, message, code) {
    conn.sendJson(code ? { t: S2C.ERROR, message, code } : { t: S2C.ERROR, message });
  }

  /**
   * Count a lookup that found nothing (unknown room code, dead resume token) and
   * answer it. The last allowed miss cuts the connection off.
   */
  lookupFailed(conn, message, code) {
    conn.data.lookupMisses = (conn.data.lookupMisses ?? 0) + 1;
    if (conn.data.lookupMisses >= MAX_LOOKUP_MISSES) {
      this.fail(conn, 'too many failed attempts', 'rate_limited');
      conn.close(1008, 'too many failed lookups');
      return undefined;
    }
    return this.fail(conn, message, code);
  }

  /**
   * A throw inside one room's timer, action or teardown ends that table's hand and
   * nothing else. The room goes back to its lobby: a stale state left in 'playing'
   * would wedge the table (no bot timer, no way to deal), and a 'finished' phase
   * with no result frame leaves clients on a table that never settles.
   */
  isolate(room, error) {
    console.error('room error:', error);
    if (!room) return;
    clearTimeout(room.botTimer);
    try {
      // Before the state goes: it names whose purses are still keyed by member id.
      this.stashLeavers(room);
    } catch (stashError) {
      console.error('room error while filing purses:', stashError);
    }
    room.phase = 'lobby';
    room.state = null;
    room.lastResult = null;
    try {
      this.broadcast(room, { t: S2C.ERROR, message: 'this table hit a problem and was reset — deal again' });
      this.broadcastRoom(room);
    } catch (broadcastError) {
      console.error('room error while reporting:', broadcastError);
    }
  }

  handle(conn, message) {
    switch (message.t) {
      case C2S.CREATE: return this.create(conn, message);
      case C2S.JOIN: return this.join(conn, message);
      case C2S.SETTINGS: return this.updateSettings(conn, message);
      case C2S.SEAT_FILL: return this.setHumanSeats(conn, message);
      case C2S.SET_GAME: return this.setGame(conn, message);
      case C2S.SIT: return this.sit(conn, message);
      case C2S.STAND: return this.stand(conn, message);
      case C2S.TO_LOBBY: return this.toLobby(conn);
      case C2S.START: return this.start(conn);
      case C2S.AGAIN: return this.again(conn);
      case C2S.BID:
      case C2S.PLAY:
      case C2S.PASS: return this.action(conn, message);
      case C2S.CHAT: return this.chat(conn, message);
      case C2S.RESUME: return this.resume(conn, message);
      case C2S.LEAVE: return this.disconnect(conn, true);
      default: return this.fail(conn, `unknown message "${message.t}"`);
    }
  }

  // --- room lifecycle --------------------------------------------------------

  create(conn, message) {
    // Checked before leaving the current room: a refused create should not
    // cost the player the seat they already have.
    if (this.rooms.size >= this.options.maxRooms) this.evictMemberless();
    if (this.rooms.size >= this.options.maxRooms) {
      return this.fail(conn, 'the server is full right now — try again in a few minutes', 'server_full');
    }
    const ip = conn.data?.ip;
    // An address the server flagged as a proxy's (ipTrusted false) is shared by
    // every player behind it, so a per-address cap would lock them all out together.
    if (ip && conn.data.ipTrusted !== false) {
      // The room this connection is about to leave does not count against it.
      let live = 0;
      for (const other of this.rooms.values()) {
        if (other.creatorIp === ip && other.members.size > 0 && other.code !== conn.data.room) live += 1;
      }
      if (live >= this.options.maxRoomsPerIp) {
        this.logLimit(`per-IP room cap reached by ${ip} (X-Forwarded-For entries: ${conn.data.forwardedEntries ?? 'unknown'})`);
        return this.fail(conn, 'too many rooms from your connection', 'rate_limited');
      }
    }
    if (conn.data.room) this.disconnect(conn, true);
    let code = generateCode();
    while (this.rooms.has(code)) code = generateCode();
    const settings = sanitiseSettings(message.settings);
    const adapter = gameAdapter(settings.game);
    const room = {
      code,
      adapter,
      creatorIp: conn.data?.ip,
      hostId: conn.id,
      settings,
      members: new Map(),
      seats: new Array(adapter.seats).fill(null),
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
    const member = this.seat(room, conn, message.name, 0);
    this.sendRoom(room, member, { code });
    this.broadcastRoom(room);
    return undefined;
  }

  join(conn, message) {
    const code = String(message.code ?? '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.lookupFailed(conn, `no room with the code ${code}`);
    // Leave the old seat first: a player re-joining the room they already fill
    // frees their own seat, so it must not count against capacity or evict a ghost.
    if (conn.data.room) {
      this.disconnect(conn, true);
      // Leaving the room it is about to rejoin may have dropped it as empty.
      if (!this.rooms.has(room.code)) this.rooms.set(room.code, room);
    }
    // A member who dropped still holds a seat (or a place in the stands) for a
    // resume, so they count here. The longest-gone one is the first to lose theirs.
    const longestGone = (wanted) => {
      let found = null;
      for (const m of room.members.values()) {
        if (!m.connected && wanted(m) && (!found || m.disconnectedAt < found.disconnectedAt)) found = m;
      }
      return found;
    };
    // A hand in progress keeps its table; a newcomer watches until it ends.
    const open = room.phase !== 'playing';
    let seatIndex = null;
    if (open && this.seatedCount(room) < room.settings.humanSeats && room.seats.includes(null)) {
      seatIndex = room.seats.indexOf(null);
    } else if (open && this.seatedCount(room) >= room.settings.humanSeats) {
      const evict = longestGone((m) => m.seat !== null);
      if (evict) {
        seatIndex = evict.seat;
        this.releaseSeat(room, evict);
      }
    }
    if (seatIndex === null && room.members.size >= MAX_MEMBERS) {
      // A seated member who dropped mid-hand is still named by state.players, so
      // releasing them would stash their chips and then settle() would mint a
      // second purse for the same id; only the stands are fair game until the hand ends.
      const evict = longestGone((m) => room.phase !== 'playing' || m.seat === null);
      if (!evict) return this.fail(conn, 'that room is full');
      this.releaseSeat(room, evict);
    }
    const member = this.seat(room, conn, message.name, seatIndex);
    // Nobody connected is left to run the room if the host's seat was just evicted.
    const host = room.members.get(room.hostId);
    if (!host || !host.connected) room.hostId = member.id;
    delete room.emptySince;
    this.sendRoom(room, member, { code });
    this.broadcastRoom(room);
    return undefined;
  }

  seatedCount(room) {
    return room.seats.filter((id) => id !== null).length;
  }

  /** `seatIndex` null seats the member as a spectator: in the room, watching, holding no seat. */
  seat(room, conn, rawName, seatIndex) {
    const seat = seatIndex ?? null;
    const name = cleanName(rawName) || `Player ${seat === null ? room.members.size + 1 : seat + 1}`;
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
    if (seat !== null) room.seats[seat] = member.id;
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
    // Settings never carry the game: the seats array and the engine are built for
    // it, and switching them is setGame()'s job.
    room.settings = sanitiseSettings({ ...room.settings, ...message.settings, game: room.settings.game });
    for (const id of room.chips.keys()) room.chips.set(id, room.settings.startingChips);
    room.departed.clear(); // a new starting stack resets everyone, including those away
    this.broadcastRoom(room);
    return undefined;
  }

  setHumanSeats(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can change the seats');
    if (room.phase !== 'lobby') return this.fail(conn, 'the seats are locked once a hand is dealt');
    const wanted = Math.min(room.adapter.seats, Math.max(this.seatedCount(room), Math.round(Number(message.humanSeats) || 1)));
    room.settings.humanSeats = wanted;
    this.broadcastRoom(room);
    return undefined;
  }

  /**
   * Switch the room's game between hands. Members, chips and the stack stay; only
   * the table is rebuilt, so the pot is re-derived for the new game's stake scale.
   */
  setGame(conn, message) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can change the game');
    if (room.phase === 'playing') return this.fail(conn, 'finish the hand before changing the game');
    const game = message.game;
    if (typeof game !== 'string' || !Object.hasOwn(SEATS_BY_GAME, game)) return this.fail(conn, 'unknown game');
    if (game === room.settings.game) {
      this.broadcastRoom(room);
      return undefined;
    }
    clearTimeout(room.botTimer);
    const oldHumanSeats = room.settings.humanSeats;
    room.adapter = gameAdapter(game);
    // Players' own chips stay as they are; only the room's reference stack is lifted.
    const stack = game === 'big2' ? Math.max(BIG2_MIN_STACK, room.settings.startingChips) : room.settings.startingChips;
    room.settings = sanitiseSettings({ ...room.settings, game, startingChips: stack, pot: potForStack(game, stack) });

    const newN = room.adapter.seats;
    const oldN = room.seats.length;
    const seats = new Array(newN).fill(null);
    const overflow = [];
    for (const id of room.seats) {
      const m = id === null ? null : room.members.get(id);
      if (!m) continue;
      if (m.seat < newN) seats[m.seat] = m.id;
      else overflow.push(m);
    }
    // The host keeps a seat through a shrink: if the table is full the highest
    // non-host steps down to the stands instead.
    const hostIndex = overflow.findIndex((m) => m.id === room.hostId);
    if (hostIndex > 0) overflow.unshift(...overflow.splice(hostIndex, 1));
    for (const m of overflow) {
      let free = seats.indexOf(null);
      if (free < 0 && m.id === room.hostId) {
        for (let i = newN - 1; i >= 0; i--) {
          if (seats[i] !== room.hostId) {
            free = i;
            break;
          }
        }
      }
      if (free >= 0) seats[free] = m.id;
    }
    // A bigger table seats those who were watching, in the order they arrived.
    if (newN > oldN) {
      for (const m of room.members.values()) {
        const free = seats.indexOf(null);
        if (free < 0) break;
        if (m.seat === null && m.connected) seats[free] = m.id;
      }
    }
    room.seats = seats;
    for (const m of room.members.values()) {
      const index = seats.indexOf(m.id);
      m.seat = index < 0 ? null : index;
      if (m.conn?.data) m.conn.data.seat = m.seat;
    }
    room.settings.humanSeats = Math.min(newN, Math.max(oldHumanSeats, this.seatedCount(room)));
    room.state = null;
    room.lastResult = null;
    room.phase = 'lobby';
    room.dealKey = null;
    this.broadcastRoom(room);
    return undefined;
  }

  sit(conn, message) {
    const room = this.roomOf(conn);
    if (room.phase === 'playing') return this.fail(conn, 'wait for the hand to end');
    const member = room.members.get(conn.data.member);
    if (!member) return this.fail(conn, 'you are not in a room');
    const seat = message.seat;
    if (!Number.isInteger(seat) || seat < 0 || seat >= room.seats.length || room.seats[seat] !== null) {
      return this.fail(conn, 'that seat is taken');
    }
    if (member.seat !== null) room.seats[member.seat] = null;
    room.seats[seat] = member.id;
    member.seat = seat;
    conn.data.seat = seat;
    room.settings.humanSeats = Math.min(room.seats.length, Math.max(room.settings.humanSeats, this.seatedCount(room)));
    this.broadcastRoom(room);
    return undefined;
  }

  stand(conn, message) {
    const room = this.roomOf(conn);
    if (room.phase === 'playing') return this.fail(conn, 'wait for the hand to end');
    const selfId = conn.data.member;
    const targetId = typeof message.id === 'string' ? message.id : selfId;
    if (targetId !== selfId && room.hostId !== selfId) return this.fail(conn, 'only the room host can move someone else');
    const target = room.members.get(targetId);
    if (!target || target.seat === null) return this.fail(conn, 'that player is not sitting');
    room.seats[target.seat] = null;
    target.seat = null;
    if (target.conn?.data) target.conn.data.seat = null;
    this.broadcastRoom(room);
    return undefined;
  }

  /** Leave a finished hand's result and go back to the lobby, where the game can be changed. */
  toLobby(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can return to the lobby');
    if (room.phase === 'playing') return this.fail(conn, 'finish the hand first');
    if (room.phase === 'finished') {
      clearTimeout(room.botTimer);
      room.state = null;
      room.lastResult = null;
      room.phase = 'lobby';
    }
    this.broadcastRoom(room);
    return undefined;
  }

  /** A hand needs at least one person at the table to deal it to. */
  nobodySeated(room) {
    return ![...room.members.values()].some((m) => m.seat !== null && m.connected);
  }

  // --- play ------------------------------------------------------------------

  start(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can start the hand');
    if (room.phase === 'playing') return this.fail(conn, 'the hand is already running');
    if (this.nobodySeated(room)) return this.fail(conn, 'nobody is sitting at the table');
    try {
      this.deal(room);
    } catch (error) {
      this.isolate(room, error);
    }
    return undefined;
  }

  again(conn) {
    const room = this.roomOf(conn);
    if (room.hostId !== conn.data.member) return this.fail(conn, 'only the room host can deal again');
    if (this.nobodySeated(room)) return this.fail(conn, 'nobody is sitting at the table');
    try {
      this.deal(room);
    } catch (error) {
      this.isolate(room, error);
    }
    return undefined;
  }

  deal(room) {
    clearTimeout(room.botTimer);
    const { adapter } = room;
    const skill = adapter.skillByName(room.settings.botSkill);
    const spare = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const players = [];
    for (let seat = 0; seat < adapter.seats; seat++) {
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
    room.state = adapter.createGame({ seed, players, settings: room.settings });
    room.rng = makeRng(`${seed}:bots`);
    room.phase = 'playing';
    room.handNo += 1;
    room.lastResult = null;
    room.lastActivity = Date.now();
    this.broadcastRoom(room);
    this.broadcastViews(room);
    this.scheduleBots(room);
  }

  action(conn, message) {
    const room = this.roomOf(conn);
    const apply = room.adapter.actions[message.t];
    if (!apply) return this.fail(conn, 'that move is not part of this game');
    if (room.phase !== 'playing' || !room.state) return this.fail(conn, 'no hand is running');
    const member = room.members.get(conn.data.member);
    if (!member || member.seat === null) return this.fail(conn, 'you are not seated');
    const before = room.adapter.snapshot(room.state, member.seat);
    const result = apply(room.state, member.seat, message);
    if (!result?.ok) return this.fail(conn, result?.error ?? 'that move was refused');
    // The move is already applied; a throw from here on would leave a 'playing'
    // room that nothing is scheduled to advance.
    try {
      this.announce(room, member.seat, undefined, before);
      room.lastActivity = Date.now();
      this.afterAction(room);
    } catch (error) {
      this.isolate(room, error);
    }
    return undefined;
  }

  afterAction(room) {
    this.broadcastViews(room);
    if (room.adapter.isFinished(room.state)) this.settle(room);
    else this.scheduleBots(room);
  }

  scheduleBots(room) {
    clearTimeout(room.botTimer);
    if (!room.state || room.adapter.isFinished(room.state)) return;
    // Fresh cards (a new hand, or the engine's redeal after three passes) get the
    // deal animation's worth of quiet before the first bot moves. The deadline is
    // stored, not just applied once, so a drop or resume inside the grace (which
    // reschedules) cannot cut it short.
    const dealKey = `${room.handNo}:${room.state.deal ?? 0}`;
    if (dealKey !== room.dealKey) room.graceUntil = Date.now() + this.options.dealGraceMs;
    room.dealKey = dealKey;
    if (!room.adapter.isBotTurn(room.state)) return;
    const delay = Math.max(this.options.botStepMs, (room.graceUntil ?? 0) - Date.now());
    room.botTimer = setTimeout(() => {
      try {
        if (!this.rooms.has(room.code) || !room.state) return;
        const before = room.adapter.snapshot(room.state, room.adapter.seatOnTurn(room.state));
        const acted = room.adapter.botTurn(room.state, room.rng);
        if (acted) this.announce(room, acted.seat, acted, before);
        this.afterAction(room);
      } catch (error) {
        this.isolate(room, error);
      }
    }, delay);
  }

  /** Events go out before the view that reflects them, so a client can animate the move it is about to see. */
  announce(room, seat, acted, before) {
    for (const event of room.adapter.describeAction(room.state, seat, acted, before)) {
      this.broadcast(room, { t: S2C.EVENT, ...event });
    }
  }

  settle(room) {
    const { frame, changes } = room.adapter.settle(room);
    for (const [id, chips] of changes) room.chips.set(id, chips);
    this.stashLeavers(room);
    room.phase = 'finished';
    // Kept so a player who resumes after the hand ended still sees the result.
    room.lastResult = frame;
    this.broadcast(room, frame);
    this.broadcastRoom(room);
  }

  /**
   * Someone who left mid-hand kept their purse keyed by member id so a settlement
   * could pay it; once the hand is over (settled or abandoned) file it under their
   * name so a rejoin finds it. Real bots carry no " (bot)" suffix and are left alone.
   */
  stashLeavers(room) {
    for (const player of room.state?.players ?? []) {
      if (room.members.has(player.id) || !room.chips.has(player.id) || !BOT_SUFFIX.test(player.name)) continue;
      this.stash(room, player.name.replace(BOT_SUFFIX, ''), room.chips.get(player.id));
      room.chips.delete(player.id);
    }
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
    // A spectator has no seat to hand to a bot.
    const holdsSeat = playing && member.seat !== null;
    member.connected = false;
    if (holdsSeat) {
      // Hand the seat to a bot so the table does not wedge mid-hand.
      room.adapter.toBot(
        room.state.players[member.seat],
        room.adapter.skillByName(room.settings.botSkill),
        `${member.name} (bot)`,
      );
      this.broadcast(room, { t: S2C.EVENT, kind: 'left', seat: member.seat, name: member.name });
      this.scheduleBots(room);
    }
    if (explicit) {
      // state.players[seat].id still names this member, so a running hand settles
      // into the right purse (settle() then files it under their name); only the
      // seat itself is freed.
      if (holdsSeat) {
        room.members.delete(member.id);
        room.seats[member.seat] = null;
      } else {
        this.releaseSeat(room, member);
      }
    } else {
      member.disconnectedAt = Date.now();
    }

    // A lobby nobody is left in has no hand to finish and no one to resume, so
    // keeping it for the sweep only lets create-and-leave loops fill the cap.
    if (explicit && room.phase !== 'playing' && room.members.size === 0) {
      clearTimeout(room.botTimer);
      this.rooms.delete(code);
      return;
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
    if (!room || !member) return this.lookupFailed(conn, 'that seat is no longer held', 'resume_failed');

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
    const seated = member.seat !== null;
    if (seated) room.seats[member.seat] = member.id;
    room.lastActivity = Date.now();

    const playing = room.phase === 'playing' && room.state;
    // After a hand, the seat may have been handed to a newcomer; the previous
    // holder's cards and result are not theirs to see. A spectator never had any.
    const holdsHand = seated && room.state?.players[member.seat]?.id === member.id;
    this.sendRoom(room, member, { code: room.code });
    if (playing && seated) {
      // The hand may have been dealt while they were away, with a bot id in the
      // seat; settle() pays the purse named by player.id, so put theirs back.
      room.adapter.toHuman(room.state.players[member.seat], member.id, member.name);
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
    if (member.seat !== null) room.seats[member.seat] = null;
    this.stash(room, member.name, room.chips.get(member.id));
    room.chips.delete(member.id);
  }

  stash(room, name, chips) {
    if (chips === undefined) return;
    const key = name.toLowerCase();
    room.departed.set(key, (room.departed.get(key) ?? 0) + chips);
    while (room.departed.size > MAX_DEPARTED) room.departed.delete(room.departed.keys().next().value);
  }

  /** Drop rooms with no members, longest-empty first, until the room count is below the cap. */
  evictMemberless() {
    const empty = [...this.rooms.values()]
      .filter((room) => room.members.size === 0)
      .sort((a, b) => (a.emptySince ?? a.lastActivity) - (b.emptySince ?? b.lastActivity));
    for (const room of empty) {
      if (this.rooms.size < this.options.maxRooms) break;
      clearTimeout(room.botTimer);
      this.rooms.delete(room.code);
    }
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
          bot: !member,
        };
      }),
      spectators: [...room.members.values()]
        .filter((m) => m.seat === null)
        .map((m) => ({
          id: m.id,
          name: m.name,
          connected: m.connected,
          isHost: m.id === room.hostId,
          chips: room.chips.get(m.id) ?? room.settings.startingChips,
        })),
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
    member.conn.sendJson({ t: S2C.VIEW, view: room.adapter.seatView(room.state, member.seat), hand: room.handNo });
  }

  broadcastViews(room) {
    if (!room.state) return;
    for (const member of room.members.values()) {
      if (member.connected && member.seat !== null) this.sendView(room, member);
    }
  }
}

const BOT_SUFFIX = / \(bot\)$/;

function cleanName(value) {
  return String(value ?? '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 18);
}
