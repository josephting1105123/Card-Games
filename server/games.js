/**
 * What rooms.js needs to know about each game, in one place.
 *
 * A room is the same machine for every game: seats, tokens, held seats, chips,
 * bots on a timer. Only the engine behind it differs, so the differences live
 * here as one adapter per game and rooms.js never names an engine.
 *
 * Players come into createGame as { id, name, isBot, skill }. The engines
 * spell that differently (Dou Di Zhu keeps isBot, Big Two keeps isHuman), which
 * is why bot/human conversion goes through the adapter too.
 */

import { settleDouDiZhu } from '../src/core/economy.js';
import * as dou from '../src/games/doudizhu/engine.js';
import { botTurn as douBotTurn } from '../src/games/doudizhu/match.js';
import { skillByName as douSkillByName } from '../src/games/doudizhu/ai.js';
import * as big2 from '../src/games/big2/engine.js';
import { botTurn as big2BotTurn } from '../src/games/big2/match.js';
import { skillByName as big2SkillByName } from '../src/games/big2/ai.js';
import * as malaysian from '../src/games/blackjack/malaysian.js';
import { createShoe, malaysianTotal } from '../src/games/blackjack/cards.js';
import * as holdemEngine from '../src/games/holdem/engine.js';
import { botTurn as holdemBotTurn } from '../src/games/holdem/match.js';
import { skillByName as holdemSkillByName } from '../src/games/holdem/ai.js';
import { makeRng } from '../src/core/rng.js';
import { C2S, S2C, blackjackLimits } from '../src/net/protocol.js';

const doudizhu = {
  id: 'doudizhu',
  seats: 3,
  skillByName: douSkillByName,
  createGame: ({ seed, players, settings }) => dou.createGame({ seed, players, baseMultiplier: settings.baseMultiplier }),
  seatOnTurn: (state) => (state.phase === dou.Phase.BIDDING ? state.bidding.turn : state.turn),
  isBotTurn(state) {
    return !!state.players[this.seatOnTurn(state)]?.isBot;
  },
  isFinished: (state) => state.phase === dou.Phase.FINISHED,
  botTurn: (state, rng) => douBotTurn(state, rng),
  seatView(state, seat) {
    const view = dou.seatView(state, seat);
    // Every hand is public once the deal has ended.
    if (state.phase === dou.Phase.FINISHED) view.revealedHands = state.players.map((p) => p.hand);
    return view;
  },
  isBot: (player) => !!player.isBot,
  toBot(player, skill, name) {
    player.isBot = true;
    player.skill = skill;
    player.name = name;
  },
  toHuman(player, id, name) {
    player.isBot = false;
    player.id = id;
    player.name = name;
  },
  // Which C2S kinds this game accepts, and how each is applied to the engine.
  actions: {
    bid: (state, seat, message) => dou.bid(state, seat, Number(message.value)),
    play: (state, seat, message) => dou.play(state, seat, message.cards ?? []),
    pass: (state, seat) => dou.pass(state, seat),
  },
  // Dou Di Zhu needs nothing from before the move.
  snapshot: () => null,
  /**
   * Only bidding is broadcast as a spoken bubble. Plays and passes travel in the
   * seat view as trickPlays and land on the felt in front of the seat that made
   * them, which says who moved without a caption.
   */
  describeAction(state, seat, acted) {
    const last = state.log[state.log.length - 1];
    if (acted?.kind !== 'bid' && last?.kind !== 'bid') return [];
    const value = acted?.value ?? last.value;
    return [{ kind: 'say', seat, text: value === 0 ? 'No call' : `${value}` }];
  },
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
    for (let seat = 0; seat < this.seats; seat++) {
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
    if (pot > totalClaimed) {
      // The losers owe more than the winners may claim (the hand ceiling holds
      // the winning side down): the winners keep their claims and the losers
      // pay only that, shared out in proportion to what each owed.
      let taken = 0;
      losers.forEach((row, index) => {
        const share = index === losers.length - 1
          ? totalClaimed - taken
          : Math.floor((totalClaimed * Math.abs(row.delta)) / pot);
        taken += share;
        row.capped = true;
        row.delta = -share;
      });
    } else if (totalClaimed > 0) {
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

    const changes = [];
    for (const row of rows) {
      const player = room.state.players[row.seat];
      const chips = Math.max(0, row.bankroll + row.delta);
      changes.push([player.id, chips]);
      row.chips = chips;
      delete row.bankroll;
    }
    // result.multiplier already carries the room's base factor — the engine was
    // created with it — so there is no floor left to apply here.
    return { frame: { t: S2C.RESULT, result, rows, multiplier: result.multiplier }, changes };
  },
};

const bigTwo = {
  id: 'big2',
  seats: 4,
  skillByName: big2SkillByName,
  createGame({ seed, players }) {
    const state = big2.createGame({
      seed,
      players: players.map((p) => ({ name: p.name, isHuman: !p.isBot, skill: p.skill })),
    });
    // The engine keeps only name/isHuman/skill; the room settles chips by id.
    players.forEach((p, seat) => { state.players[seat].id = p.id; });
    return state;
  },
  seatOnTurn: (state) => state.turn,
  isBotTurn: (state) => !!state.players[state.turn] && !state.players[state.turn].isHuman,
  isFinished: (state) => state.phase === big2.Phase.FINISHED,
  botTurn: (state, rng) => big2BotTurn(state, rng),
  seatView(state, seat) {
    const view = big2.seatView(state, seat);
    // Every hand is public once the hand has ended.
    if (state.phase === big2.Phase.FINISHED) view.revealedHands = state.hands;
    return view;
  },
  isBot: (player) => !player.isHuman,
  toBot(player, skill, name) {
    player.isHuman = false;
    player.skill = skill;
    player.name = name;
  },
  toHuman(player, id, name) {
    player.isHuman = true;
    player.id = id;
    player.name = name;
  },
  actions: {
    play: (state, seat, message) => big2.play(state, seat, message.cards ?? []),
    pass: (state, seat) => big2.pass(state, seat),
  },
  // play() always leaves state.trick set, so "was this a lead" has to be read
  // before the move lands.
  snapshot: (state) => ({ leading: !state.trick, historyLength: state.history.length }),
  /** Read the move back out of the engine's history, so a bot's fallback is described as what it really did. */
  describeAction(state, seat, acted, before) {
    if (!before || state.history.length <= before.historyLength) return [];
    const last = state.history[state.history.length - 1];
    if (last.seat !== seat) return [];
    if (last.action === 'play') return [{ kind: 'play', seat, cards: last.combo.cards, leading: before.leading }];
    // Three passes in a row clear the trick.
    return [{ kind: 'pass', seat, resolved: state.trick === null }];
  },
  settle(room) {
    const { state, settings } = room;
    const rate = settings.pot / 10;
    const { payouts, cardsLeft } = big2.settle(state, rate);
    const rows = [];
    let paidTotal = 0;
    let anyCapped = false;
    for (let seat = 0; seat < this.seats; seat++) {
      const player = state.players[seat];
      const bankroll = room.chips.get(player.id) ?? settings.startingChips;
      const won = seat === state.winner;
      let delta = 0;
      let capped = false;
      if (!won) {
        // Chips are whole units: a pot that is not a multiple of 10 rounds per player.
        const owed = Math.round(-payouts[seat]);
        const paid = Math.min(owed, bankroll);
        capped = paid < owed;
        anyCapped ||= capped;
        paidTotal += paid;
        delta = -paid;
      }
      rows.push({ seat, name: player.name, isBot: this.isBot(player), cardsLeft: cardsLeft[seat], delta, chips: 0, capped, won, bankroll });
    }
    const changes = [];
    for (const row of rows) {
      if (row.won) {
        row.delta = paidTotal;
        row.capped = anyCapped;
      }
      row.chips = row.bankroll + row.delta;
      changes.push([state.players[row.seat].id, row.chips]);
      delete row.bankroll;
    }
    return { frame: { t: S2C.RESULT, game: 'big2', winner: state.winner, rate, rows }, changes };
  },
};

/**
 * Malaysian Blackjack. Room seat 0 is the banker's box (a person banks if one is
 * seated there, a bot otherwise); room seats 1-4 are the engine's four player
 * seats, so engine seat i is room seat i + 1.
 *
 * rooms.js wants state.players indexed by room seat with { id, name, isBot }, so
 * the state wraps the engine's round. The wrapper's isBot says who acts; the
 * engine's own isHuman is only set false just before it plays a bot's turn.
 */
const clampInt = (value, low, high) => Math.max(low, Math.min(high, Math.round(value)));

const bjPhase = (state) => state.round.phase;

const bjMove = (apply) => (state, seat) => (
  seat >= 1 ? apply(state.round, seat - 1, state.deck) : { ok: false, error: 'not your move' }
);

const blackjack = {
  id: 'blackjack',
  seats: 5,
  // The engine's bots have one fixed policy; there is no skill to pick.
  skillByName: () => null,
  // The house filler (bots) is topped back up between hands so a banker or seat
  // that went broke does not leave the table short of players.
  rebuyBots: true,
  createGame({ seed, players, settings }) {
    const rng = makeRng(`${seed}:deal`);
    const deck = createShoe(1, rng);
    const limits = blackjackLimits(settings);
    const seats = [];
    for (let i = 0; i < 4; i++) {
      const player = players[i + 1];
      if (player.isBot) {
        seats.push({ isHuman: false, name: player.name });
      } else if ((player.chips ?? 0) < 1) {
        seats.push(null); // out of chips: sits the hand out
      } else {
        // A short purse lowers the floor too: a bet stored while chips were short must not play on below the minimum.
        const bet = clampInt(player.bet ?? limits.min, Math.min(limits.min, player.chips), Math.min(limits.max, player.chips));
        seats.push({ isHuman: true, name: player.name, bet });
      }
    }
    const round = malaysian.startTableRound({ deck, table: limits, rng, seats, bankerIsHuman: !players[0].isBot });
    return {
      game: 'blackjack',
      round,
      deck,
      limits,
      // dealtHuman: a seat dealt to a bot (its member was away) stays the house's for the hand,
      // so a resume cannot swap a bot-sized bet or a declined Run for the member's own.
      players: players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, dealtHuman: !p.isBot })),
    };
  },
  seatOnTurn(state) {
    if (bjPhase(state) === 'players') return state.round.activeSeat + 1;
    return bjPhase(state) === 'banker' ? 0 : -1;
  },
  isBotTurn(state) {
    if (bjPhase(state) === 'players') return !!state.players[state.round.activeSeat + 1]?.isBot;
    return bjPhase(state) === 'banker' ? !!state.players[0].isBot : false;
  },
  isFinished: (state) => !!state.round.settled,
  botTurn(state, rng) {
    const { round, deck } = state;
    if (round.phase === 'players') {
      const index = round.activeSeat;
      const p = round.players[index];
      // A human who dropped is a bot now, but the engine still remembers the seat as theirs.
      p.isHuman = false;
      if (p.bankerSpecialPending) {
        // Declining Run would hand the held-back banker special its 2-3x loss; running is a push.
        malaysian.runSeat(round, index);
        return { seat: index + 1, kind: 'run' };
      }
      malaysian.playSeatTurn(round, index, deck, rng);
      return { seat: index + 1, kind: 'play' };
    }
    const step = malaysian.bankerBotStep(round, deck, rng);
    return { seat: 0, kind: step.type, ...(step.seatIndex === undefined ? {} : { target: step.seatIndex + 1 }) };
  },
  isBot: (player) => !!player.isBot,
  // A seat dealt to a bot stays one: its member was away at the deal, and swapping them in
  // mid-hand would trade the bot's bet and Run decision for theirs.
  toBot(player, skill, name) {
    if (!player.dealtHuman) return;
    player.isBot = true;
    player.skill = skill;
    player.name = name;
  },
  toHuman(player, id, name) {
    if (!player.dealtHuman) return;
    player.isBot = false;
    player.id = id;
    player.name = name;
  },
  actions: {
    [C2S.BJ_RUN]: bjMove(malaysian.runSeat),
    [C2S.BJ_STAND]: bjMove(malaysian.standSeat),
    [C2S.BJ_HIT](state, seat) {
      if (seat === 0) return malaysian.bankerHit(state.round, state.deck);
      return bjMove(malaysian.hitSeat)(state, seat);
    },
    [C2S.BJ_OPEN](state, seat, message) {
      if (seat !== 0) return { ok: false, error: 'not your move' };
      const target = Number(message.seat) - 1;
      if (!Number.isInteger(target) || target < 0 || target > 3) return { ok: false, error: 'no such seat' };
      return malaysian.openSeat(state.round, target);
    },
  },
  // The views carry the whole table, so there is nothing to caption or to read back.
  snapshot: () => null,
  describeAction: () => [],
  seatView(state, viewerSeat) {
    const { round } = state;
    const settled = round.phase === 'settled';
    const bankerSees = viewerSeat === 0 || round.phase !== 'players';
    const bankerCards = bankerSees ? round.banker.cards : round.banker.cards.map((card, i) => (i === 0 ? card : null));
    const seats = round.players.map((p, i) => {
      if (!p) return null;
      // The banker is the one person who may not see an unopened hand; everyone else shares the table.
      const visible = settled || p.opened || viewerSeat !== 0;
      return {
        seat: i + 1,
        name: p.name,
        isBot: !!state.players[i + 1]?.isBot,
        bet: p.bet,
        count: p.cards.length,
        cards: visible ? p.cards : p.cards.map(() => null),
        opened: p.opened,
        // A hidden seat that is done is either standing or bust; saying which would leak the bust.
        stood: visible ? p.stood : p.stood || p.busted,
        result: p.result,
        payout: p.opened ? p.payout : 0,
        busted: visible ? p.busted : null,
        special: visible ? p.special : null,
        total: visible ? malaysianTotal(p.cards).total : null,
        bankerTotalAtOpen: p.bankerTotalAtOpen,
      };
    });
    const you = { canRun: false, canHit: false, canStand: false, canBankerHit: false, openable: [] };
    if (state.players[viewerSeat]?.isBot) {
      // A member who resumed into a seat dealt to a bot only watches this hand: no buttons.
    } else if (viewerSeat === 0) {
      you.canBankerHit = malaysian.canBankerHit(round);
      round.players.forEach((p, i) => { if (p && malaysian.canOpenSeat(round, i)) you.openable.push(i + 1); });
    } else if (viewerSeat >= 1) {
      const i = viewerSeat - 1;
      you.canRun = malaysian.canRunSeat(round, i);
      you.canHit = malaysian.canHitSeat(round, i);
      you.canStand = malaysian.canStandSeat(round, i);
    }
    return {
      game: 'blackjack',
      phase: round.phase,
      seat: viewerSeat,
      activeSeat: this.seatOnTurn(state),
      limits: state.limits,
      banker: {
        name: state.players[0].name,
        isBot: !!state.players[0].isBot,
        count: round.banker.cards.length,
        cards: bankerCards,
        special: bankerSees ? round.banker.special : null,
        total: bankerSees ? malaysianTotal(round.banker.cards).total : null,
      },
      seats,
      you,
    };
  },
  /**
   * The engine's payouts are what each seat wins from the banker (negative: pays
   * it). A losing seat pays at most the chips it has; the banker collects that,
   * and winners are paid out of the banker's chips plus the collection. If the
   * banker cannot cover everyone, winners are cut back pro rata. Whatever is not
   * paid out stays with the banker, so the deltas always sum to zero.
   */
  settle(room) {
    const { state } = room;
    const chipsOf = (player) => room.chips.get(player.id) ?? room.settings.startingChips;
    const banker = state.players[0];
    const rows = [];
    let collected = 0;
    const winners = [];
    state.round.players.forEach((p, i) => {
      if (!p) return;
      const player = state.players[i + 1];
      const chips = chipsOf(player);
      const row = {
        seat: i + 1,
        name: player.name,
        isBot: !!player.isBot,
        isBanker: false,
        delta: 0,
        chips,
        capped: false,
        won: false,
        result: p.result,
      };
      if (p.payout < 0) {
        const paid = Math.min(-p.payout, chips);
        row.capped = paid < -p.payout;
        row.delta = -paid;
        collected += paid;
      } else if (p.payout > 0) {
        winners.push({ row, owed: p.payout });
      }
      rows.push({ row, player });
    });

    const bankerChips = chipsOf(banker);
    const available = bankerChips + collected;
    const owedTotal = winners.reduce((sum, w) => sum + w.owed, 0);
    let paidOut = 0;
    let bankerCapped = false;
    winners.forEach((w, index) => {
      let share = w.owed;
      if (owedTotal > available) {
        const rest = available - paidOut;
        // The last winner takes the remainder; it never exceeds what the engine owes it.
        share = index === winners.length - 1 ? Math.min(w.owed, rest) : Math.floor((available * w.owed) / owedTotal);
        w.row.capped = share < w.owed;
        bankerCapped ||= w.row.capped;
      }
      w.row.delta = share;
      paidOut += share;
    });

    const bankerRow = {
      seat: 0,
      name: banker.name,
      isBot: !!banker.isBot,
      isBanker: true,
      delta: collected - paidOut,
      chips: bankerChips,
      capped: bankerCapped,
      won: false,
      result: null,
    };
    // A player with no chips sat the hand out, but still needs a row: without one their
    // client never shows a result, and if they are the host nobody can deal again.
    state.round.players.forEach((p, i) => {
      if (p) return;
      const player = state.players[i + 1];
      rows.push({
        row: {
          seat: i + 1,
          name: player.name,
          isBot: !!player.isBot,
          isBanker: false,
          delta: 0,
          chips: chipsOf(player),
          capped: false,
          won: false,
          result: 'out',
        },
        player,
      });
    });
    rows.sort((a, b) => a.row.seat - b.row.seat);
    const all = [{ row: bankerRow, player: banker }, ...rows];
    const changes = [];
    for (const { row, player } of all) {
      row.chips += row.delta;
      row.won = row.delta > 0;
      changes.push([player.id, row.chips]);
    }
    return { frame: { t: S2C.RESULT, game: 'blackjack', rows: all.map((entry) => entry.row) }, changes };
  },
};

/**
 * No-limit Texas Hold'em, six seats. The room's pot is the big blind; the engine
 * keeps the stacks, so a seat's room chips go in as its stack and its final stack
 * goes back out. Bots are topped up between hands (rebuyBots) so the table always
 * has two funded seats to deal to.
 */
const holdem = {
  id: 'texas',
  seats: 6,
  skillByName: holdemSkillByName,
  rebuyBots: true,
  // The engine cannot deal to fewer than two funded seats; rooms.js refuses the deal instead of resetting.
  canDeal: (players) => players.filter((p) => p.chips > 0).length >= 2,
  createGame({ seed, players, settings, previous, lastHoldemButton }) {
    const seats = players.map((p) => ({
      name: p.name,
      isHuman: !p.isBot,
      isBot: !!p.isBot,
      skill: p.skill,
      stack: p.chips,
    }));
    const bigBlind = settings.pot;
    const smallBlind = Math.max(1, Math.floor(settings.pot / 2));
    // previous is whatever the room last dealt, which may be another game's state or
    // nothing (a reset to the lobby); the room keeps the last Hold'em button for that.
    const button = holdemEngine.nextButton(seats, previous?.game === 'holdem' ? previous.button : (lastHoldemButton ?? -1));
    // createHand throws when fewer than two seats have chips; rooms.js isolates that.
    const state = holdemEngine.createHand({ seed, players: seats, button, smallBlind, bigBlind });
    // The engine keeps no ids; the room settles chips by id.
    // dealtHuman: a seat dealt to a bot (its member was away) stays the house's for the hand,
    // so a resume cannot hand the member the bot's stack or its purse's settlement.
    players.forEach((p, seat) => {
      state.players[seat].id = p.id;
      state.players[seat].dealtHuman = !p.isBot;
    });
    return state;
  },
  seatOnTurn: (state) => state.turn,
  isBotTurn: (state) => state.turn >= 0 && !!state.players[state.turn] && !state.players[state.turn].isHuman,
  isFinished: (state) => state.phase === holdemEngine.Phase.FINISHED,
  botTurn: (state, rng) => holdemBotTurn(state, rng),
  seatView(state, seat) {
    const view = holdemEngine.seatView(state, seat);
    // A member resumed into a seat a bot was dealt holds no controls for the hand.
    if (!state.players[seat].isHuman) view.legal = null;
    return view;
  },
  isBot: (player) => !player.isHuman,
  toBot(player, skill, name) {
    if (!player.dealtHuman) return;
    player.isHuman = false;
    player.isBot = true;
    player.skill = skill;
    player.name = name;
  },
  toHuman(player, id, name) {
    if (!player.dealtHuman) return;
    player.isHuman = true;
    player.isBot = false;
    player.id = id;
    player.name = name;
  },
  actions: {
    [C2S.HOLDEM_ACT]: (state, seat, message) => holdemEngine.act(state, seat, {
      type: String(message.action?.type ?? ''),
      amount: Number(message.action?.amount),
    }),
  },
  snapshot: () => null,
  // The view carries the whole action log and HoldemView draws each seat's bubble from it.
  describeAction: () => [],
  settle(room) {
    const { state } = room;
    const { result } = state;
    const rows = state.players.map((p, seat) => ({
      seat,
      name: p.name,
      isBot: !p.isHuman,
      delta: result.net[seat],
      chips: p.stack,
      won: result.net[seat] > 0,
    }));
    const changes = state.players.map((p) => [p.id, p.stack]);
    return {
      frame: { t: S2C.RESULT, game: 'texas', rows, pots: result.pots, uncontested: !!result.uncontested },
      changes,
    };
  },
};

export const GAMES = { doudizhu, big2: bigTwo, blackjack, texas: holdem };

/** An unknown id falls back to Dou Di Zhu, matching sanitiseSettings. */
export function gameAdapter(id) {
  return Object.hasOwn(GAMES, id) ? GAMES[id] : GAMES.doudizhu;
}
