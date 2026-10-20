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
import { S2C } from '../src/net/protocol.js';

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
  seatView: (state, seat) => dou.seatView(state, seat),
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

export const GAMES = { doudizhu, big2: bigTwo };

/** An unknown id falls back to Dou Di Zhu, matching sanitiseSettings. */
export function gameAdapter(id) {
  return Object.hasOwn(GAMES, id) ? GAMES[id] : GAMES.doudizhu;
}
