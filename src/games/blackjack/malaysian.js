/**
 * Malaysian Blackjack (Ban Luck): one table, five boxes — a banker and four
 * player seats — with the human sitting in exactly one of them at a time.
 *
 * Both of the old two seats (the solo player-vs-house table, and the human
 * dealing against four fixed bots) are now the same round shape, just with
 * different occupants: `startTableRound` takes up to four seats (any of
 * which may be empty, a bot, or the human) plus a banker who is either the
 * human or a bot. The old single-player table is exactly this with seat 0
 * human and the other three seats empty; the old dealer seat is exactly this
 * with all four seats non-human and the banker human.
 *
 * SPECIALS AND RUN: checked the instant the first two cards land, on every
 * hand. Ban Ban (a pair of aces) pays 3:1, Ban Luck (ace + a ten-value card)
 * pays 2:1. On an opening two-card 15, a seat may Run instead of playing it
 * out — an instant push — and Run always gets first refusal: it is decided
 * (by every bot, instantly; by the human, at their turn) before the banker's
 * own special, if any, is applied to that seat. A bot's run/decline is
 * settled at the deal (decideOpeningRunsForBots); the human's is deferred —
 * `player.bankerSpecialPending` — until they act, exactly mirroring the
 * held-back-special mechanic the old single-player table used, just scoped
 * to one seat instead of the whole round. A banker special that reaches a
 * seat (no run available, or run declined) ends that seat's round at once:
 * a loss at the special's multiple, unless the seat holds a special of its
 * own that is strictly better (a win at the seat's own multiple — Ban Ban
 * beats a Ban Luck banker) or equal (a push). 777 pays 7:1, and Five Dragon
 * (five cards totalling 21 or less) pays 2:1, or 3:1 on exactly 21 — both
 * win the instant they are made, seat or banker side.
 *
 * TURN ORDER: seats act in order (`nextActionableSeat`). A bot's whole turn
 * resolves at once (`playSeatTurn`, unchanged from the old bot AI — cards
 * only, no dealer/banker information); the human's turn is driven one action
 * at a time (`hitSeat`/`standSeat`/`runSeat`). A bust is not settled on the
 * spot — it stays hidden (`busted`, not `opened`) until the banker opens
 * that seat, same as ever.
 *
 * BANKER'S TURN: once every seat is done, the banker (human or bot) draws
 * below 16 and, once at 16 or more, opens seats — each opening settles that
 * seat against the banker's total *at that moment*, so a later draw only
 * changes what is compared against for seats opened after it. A bot banker
 * follows a fixed policy (`bankerBotStep`, one action per call so the UI can
 * pace it): opens every ≥3-card hand first, may draw again chasing a better
 * total while ≤17 and 2-card hands remain (never above five cards), then
 * stands and opens the rest. Its decisions read only its own cards and each
 * seat's card *count* and opened/busted state — never a seat's ranks, the
 * same blindness a human banker has to face-down seats.
 */

import { drawCard, isAce, isSeven, isTenValue, malaysianTotal } from './cards.js';

const SPECIAL_MULTIPLE = { banluck: 2, banban: 3 };
const SPECIAL_RANK = { banluck: 1, banban: 2 };

function detectSpecial(cards) {
  if (cards.length !== 2) return null;
  const aces = cards.filter(isAce).length;
  if (aces === 2) return 'banban';
  if (aces === 1 && cards.some(isTenValue)) return 'banluck';
  return null;
}

export const BOT_NAMES = ['Azman', 'Bee', 'Chandra', 'Farid'];
export const SEAT_COUNT = BOT_NAMES.length;

/** A bet within the table's ladder, always a multiple of its minimum — the
 * same denominations a human would be offered at this table. */
export function randomBotBet(table, rng) {
  const steps = Math.floor((table.max - table.min) / table.min) + 1;
  return table.min + Math.floor(rng() * steps) * table.min;
}

/** Each filled bot seat can pull a 7:1 777 against the banker at once — the
 * bankroll has to survive that worst case, per seat, to bank. Replaces the
 * old fixed "4 bots always" 28x with a per-seat 7x so a table with fewer
 * bots opens up sooner. */
export function bankRequirement(table, filledSeats) {
  return table.max * 7 * filledSeats;
}

export function canBank(table, bankroll, filledSeats) {
  if (filledSeats < 1) return false;
  return bankroll >= bankRequirement(table, filledSeats);
}

/**
 * A bot's decision on its own turn: 'run' (opening 15 only), 'hit' or
 * 'stand'. Deliberately simple, and — load-bearing, not a style choice —
 * decided from the bot's own hand alone; nothing here ever reads the
 * banker's cards, which are exactly as face-down to a bot as to a real
 * player until the banker opens that hand.
 *  - Below 16 (and not an opening 15) it always hits.
 *  - An opening 15 runs half the time — a flat coin flip.
 *  - At 16-17 with four cards or fewer, it keeps drawing for Five Dragon
 *    about a third of the time.
 *  - Anything else (18+, or no more room to chase Five Dragon) stands.
 */
function wantsToRun(rng) {
  return rng() < 0.5;
}

export function botDecide(cards, rng) {
  const { total } = malaysianTotal(cards);
  if (cards.length === 2 && total === 15) {
    return wantsToRun(rng) ? 'run' : 'hit';
  }
  if (total < 16) return 'hit';
  if (total <= 17 && cards.length <= 4) {
    return rng() < (1 / 3) ? 'hit' : 'stand';
  }
  return 'stand';
}

function isOpeningFifteen(player) {
  return player.cards.length === 2 && malaysianTotal(player.cards).total === 15;
}

function makePlayer(seat, seatIndex, table, rng) {
  return {
    seatIndex,
    isHuman: !!seat.isHuman,
    name: seat.name || BOT_NAMES[seatIndex],
    bet: seat.isHuman ? seat.bet : randomBotBet(table, rng),
    cards: [],
    special: null,
    busted: false,
    stood: false,
    opened: false,
    result: null,
    payout: 0,
    actions: [],
    bankerTotalAtOpen: null,
    runDeclined: false,
    // Only ever set true for the human — a bot's run/decline is always
    // resolved synchronously below, at the deal.
    bankerSpecialPending: false,
  };
}

/** Every bot with an opening 15 decides Run right now, before the banker's
 * own special (if any) is revealed or applied. A bot that runs is opened (a
 * push); one that declines is marked runDeclined so its later turn does not
 * ask again — it just takes the resulting hit. The human is left alone here
 * entirely; their run decision waits for their own turn. */
function decideOpeningRunsForBots(round, rng) {
  for (const p of round.players) {
    if (!p || p.isHuman || p.special) continue;
    if (isOpeningFifteen(p)) {
      if (wantsToRun(rng)) {
        p.result = 'run';
        p.payout = 0;
        p.opened = true;
        p.actions = ['run'];
      } else {
        p.runDeclined = true;
      }
    }
  }
}

function settleAgainstBankerSpecial(round, p) {
  const dealerRank = SPECIAL_RANK[round.banker.special];
  const rank = p.special ? SPECIAL_RANK[p.special] : 0;
  p.opened = true;
  if (rank > dealerRank) {
    // Strictly better than the banker's own special — wins at its own
    // multiple (Ban Ban beats a Ban Luck banker, per the rules text).
    p.result = p.special;
    p.payout = p.bet * SPECIAL_MULTIPLE[p.special];
  } else if (rank === dealerRank) {
    p.result = 'push';
    p.payout = 0;
  } else {
    p.result = 'lose';
    p.payout = -p.bet * SPECIAL_MULTIPLE[round.banker.special];
  }
}

function allPlayersOpened(round) {
  return round.players.every((p) => !p || p.opened);
}

/** Next seat still needing a turn, in seat order — a bot's turn is always
 * resolved in one call (playSeatTurn), so this only ever pauses on a human
 * or an empty stretch of seats past the last unresolved one. */
export function nextActionableSeat(round) {
  for (let i = 0; i < round.players.length; i++) {
    const p = round.players[i];
    if (p && !p.opened && !p.busted && !p.stood) return i;
  }
  return -1;
}

function finalizeOrAdvance(round) {
  if (allPlayersOpened(round)) {
    round.phase = 'settled';
    round.settled = true;
    round.activeSeat = -1;
    return;
  }
  const next = nextActionableSeat(round);
  if (next === -1) {
    round.phase = 'banker';
    round.activeSeat = -1;
  } else {
    round.phase = 'players';
    round.activeSeat = next;
  }
}

/**
 * @param {object} args
 * @param {object[]} args.deck    drawn from with drawCard(); a fresh 52-card shuffle
 * @param {object} args.table     games/blackjack/tables.js entry (min/max)
 * @param {import('../../core/rng.js').Rng} args.rng
 * @param {Array<null|{isHuman?: boolean, name?: string, bet?: number}>} args.seats
 *   length-4 seat description; null for an empty seat. A human seat must
 *   carry `bet`; a bot seat's bet is rolled here via randomBotBet.
 * @param {boolean} args.bankerIsHuman
 */
export function startTableRound({ deck, table, rng, seats, bankerIsHuman }) {
  const players = seats.map((seat, i) => (seat ? makePlayer(seat, i, table, rng) : null));
  const banker = { cards: [], special: null };

  // Round-robin, two cards each: seats in order (skipping empties), then the
  // banker, twice.
  for (let pass = 0; pass < 2; pass++) {
    for (const p of players) if (p) p.cards.push(drawCard(deck));
    banker.cards.push(drawCard(deck));
  }
  for (const p of players) if (p) p.special = detectSpecial(p.cards);
  banker.special = detectSpecial(banker.cards);

  const round = {
    variant: 'malaysian-table',
    table,
    players,
    banker,
    bankerIsHuman: !!bankerIsHuman,
    phase: 'players',
    settled: false,
    activeSeat: -1,
  };

  decideOpeningRunsForBots(round, rng);

  if (banker.special) {
    for (const p of players) {
      if (!p || p.opened) continue; // already settled by running, ahead of this
      if (p.isHuman && isOpeningFifteen(p)) { p.bankerSpecialPending = true; continue; }
      settleAgainstBankerSpecial(round, p);
    }
  } else {
    for (const p of players) {
      if (p && p.special && !p.opened) {
        p.result = p.special;
        p.payout = p.bet * SPECIAL_MULTIPLE[p.special];
        p.opened = true;
      }
    }
  }

  finalizeOrAdvance(round);
  return round;
}

// ---------------------------------------------------------------------------
// A seat's own turn — the human, one action at a time; a bot, all at once.
// ---------------------------------------------------------------------------

export function canRunSeat(round, i) {
  const p = round.players[i];
  return round.phase === 'players' && round.activeSeat === i && !!p && isOpeningFifteen(p);
}

export function runSeat(round, i) {
  if (!canRunSeat(round, i)) return { ok: false, error: 'run is only offered on an opening 15' };
  const p = round.players[i];
  p.result = 'run';
  p.payout = 0;
  p.opened = true;
  p.actions.push('run');
  p.bankerSpecialPending = false; // a push either way — the held-back special never gets to apply
  finalizeOrAdvance(round);
  return { ok: true };
}

export function canHitSeat(round, i) {
  const p = round.players[i];
  return round.phase === 'players' && round.activeSeat === i && !!p
    && !p.busted && !p.stood && !p.opened && p.cards.length < 5;
}

export function hitSeat(round, i, deck) {
  if (!canHitSeat(round, i)) return { ok: false, error: 'cannot hit' };
  const p = round.players[i];
  if (p.bankerSpecialPending) {
    // Hitting is how an opening 15 declines Run — the banker's held-back
    // special resolves this seat right here, at once, and no card is drawn.
    p.bankerSpecialPending = false;
    settleAgainstBankerSpecial(round, p);
    p.actions.push('hit');
    finalizeOrAdvance(round);
    return { ok: true };
  }
  p.cards.push(drawCard(deck));
  p.actions.push('hit');
  if (p.cards.length === 3 && p.cards.every(isSeven)) {
    p.result = '777';
    p.payout = p.bet * 7;
    p.opened = true;
    finalizeOrAdvance(round);
    return { ok: true };
  }
  const { total } = malaysianTotal(p.cards);
  if (total > 21) {
    p.busted = true; // hidden — settled only once the banker opens it
    finalizeOrAdvance(round);
    return { ok: true };
  }
  if (p.cards.length === 5) {
    p.result = 'five-dragon';
    p.payout = p.bet * (total === 21 ? 3 : 2);
    p.opened = true;
    finalizeOrAdvance(round);
  }
  return { ok: true };
}

/** Stand is disabled below 16 — the same floor every seat plays under. Note
 * this also makes standing impossible at exactly 15 (16 > 15), so an opening
 * 15's only way to decline Run is a hit, never a stand. */
export function canStandSeat(round, i) {
  const p = round.players[i];
  if (round.phase !== 'players' || round.activeSeat !== i || !p || p.busted || p.stood || p.opened) return false;
  return malaysianTotal(p.cards).total >= 16;
}

export function standSeat(round, i) {
  if (!canStandSeat(round, i)) return { ok: false, error: 'need at least 16 to stand' };
  const p = round.players[i];
  p.stood = true;
  p.actions.push('stand');
  finalizeOrAdvance(round);
  return { ok: true };
}

/** Plays one bot seat's whole turn to a decision point (run, stand, a hidden
 * bust, or an instant 777/Five Dragon payout) in one call — the UI paces
 * revealing it via p.actions, without knowing card faces. Decisions come
 * from botDecide(p.cards, rng) alone. */
export function playSeatTurn(round, i, deck, rng) {
  const p = round.players[i];
  if (!p || p.isHuman || p.opened || p.busted || p.stood) return { ok: false, error: 'not an actionable bot seat' };
  p.actions = [];
  let first = true;
  for (;;) {
    // The run/no-run call for an opening 15 already happened in
    // decideOpeningRunsForBots(), ahead of the banker's own special — a bot
    // that declined it just takes the resulting hit, without being asked again.
    const decision = (first && p.runDeclined) ? 'hit' : botDecide(p.cards, rng);
    first = false;
    p.actions.push(decision);
    if (decision === 'run') {
      p.result = 'run';
      p.payout = 0;
      p.opened = true;
      break;
    }
    if (decision === 'stand') {
      p.stood = true;
      break;
    }
    p.cards.push(drawCard(deck));
    if (p.cards.length === 3 && p.cards.every(isSeven)) {
      p.result = '777';
      p.payout = p.bet * 7;
      p.opened = true;
      break;
    }
    const t = malaysianTotal(p.cards);
    if (t.total > 21) {
      p.busted = true; // hidden — settled only once the banker opens it
      break;
    }
    if (p.cards.length === 5) {
      p.result = 'five-dragon';
      p.payout = p.bet * (t.total === 21 ? 3 : 2);
      p.opened = true;
      break;
    }
  }
  finalizeOrAdvance(round);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The banker's turn — human-driven (hit/open on demand) or bot-driven
// (bankerBotStep, one action per call).
// ---------------------------------------------------------------------------

export function canBankerHit(round) {
  return round.phase === 'banker' && round.banker.cards.length < 5;
}

function settleUnopenedOnBankerBust(round) {
  for (const p of round.players) {
    if (!p || p.opened) continue;
    p.opened = true;
    if (p.busted) { p.result = 'push'; p.payout = 0; } else { p.result = 'win'; p.payout = p.bet; }
  }
  round.phase = 'settled';
  round.settled = true;
}

function settleUnopenedForBankerWin(round, multiple) {
  for (const p of round.players) {
    if (!p || p.opened) continue;
    p.opened = true;
    p.result = 'lose';
    // A bust is a flat loss of the bet, never scaled by the banker's winning
    // multiple — busting is its own fixed penalty.
    p.payout = p.busted ? -p.bet : -p.bet * multiple;
  }
  round.phase = 'settled';
  round.settled = true;
}

export function bankerHit(round, deck) {
  if (!canBankerHit(round)) return { ok: false, error: 'cannot hit' };
  round.banker.cards.push(drawCard(deck));
  const t = malaysianTotal(round.banker.cards);
  if (t.total > 21) settleUnopenedOnBankerBust(round);
  else if (round.banker.cards.length === 3 && round.banker.cards.every(isSeven)) settleUnopenedForBankerWin(round, 7);
  else if (round.banker.cards.length === 5) settleUnopenedForBankerWin(round, t.total === 21 ? 3 : 2);
  return { ok: true };
}

/** Nothing can be opened below 16 — the banker's own floor to stand. */
export function canOpenSeat(round, i) {
  const p = round.players[i];
  if (round.phase !== 'banker' || !p || p.opened) return false;
  return malaysianTotal(round.banker.cards).total >= 16;
}

/** Opens one seat against the banker's *current* total — drawing more cards
 * after this only changes what the next opening compares against. */
export function openSeat(round, i) {
  if (!canOpenSeat(round, i)) return { ok: false, error: 'cannot open this hand yet' };
  const p = round.players[i];
  const bankerTotal = malaysianTotal(round.banker.cards).total;
  p.opened = true;
  p.bankerTotalAtOpen = bankerTotal;
  if (p.busted) {
    p.result = 'lose';
    p.payout = -p.bet;
  } else {
    const total = malaysianTotal(p.cards).total;
    if (total > bankerTotal) { p.result = 'win'; p.payout = p.bet; } else if (total < bankerTotal) { p.result = 'lose'; p.payout = -p.bet; } else { p.result = 'push'; p.payout = 0; }
  }
  if (allPlayersOpened(round)) {
    round.phase = 'settled';
    round.settled = true;
  }
  return { ok: true };
}

/**
 * One step of the bot banker's policy — a single hit or a single opening —
 * so the UI can pace revealing it. Reads only the banker's own cards and
 * every unopened seat's card *count*; never a seat's ranks, busted status
 * aside (opened/unopened and busted/not are the same information a human
 * banker gets to see about a face-down hand, not a peek at its value).
 *
 *  - Below 16: hit.
 *  - At 16+: open every unopened seat with 3+ cards first (it hit at least
 *    once on its own turn).
 *  - Once only 2-card seats remain unopened: hit again, chasing a better
 *    total, while the banker's own total is <=17 and it has fewer than 5
 *    cards; otherwise (>=18, or no cards left to draw) open the rest.
 */
export function bankerBotStep(round, deck, rng) {
  if (round.settled) return { type: 'done' };
  const unopened = round.players.filter((p) => p && !p.opened);
  if (unopened.length === 0) {
    round.phase = 'settled';
    round.settled = true;
    return { type: 'done' };
  }
  const total = malaysianTotal(round.banker.cards).total;
  const has3plus = unopened.some((p) => p.cards.length >= 3);
  const has2 = unopened.some((p) => p.cards.length === 2);
  const shouldHit = total < 16 || (!has3plus && has2 && total <= 17 && round.banker.cards.length < 5);
  if (shouldHit) {
    bankerHit(round, deck);
    return { type: 'hit', done: round.settled };
  }
  const target = unopened.find((p) => p.cards.length >= 3) ?? unopened[0];
  openSeat(round, target.seatIndex);
  return { type: 'open', seatIndex: target.seatIndex, done: round.settled };
}

/** The human's net this round: their own seat's payout alone — a bot's win
 * or loss never touches it. Only meaningful when the human is a player;
 * callers check bankerIsHuman for which side of the table they are on. */
export function tableRoundNet(round) {
  if (round.bankerIsHuman) {
    // The human banks: every seat's payout is a payment out of (or into) the
    // house, i.e. the human's own bankroll.
    return -round.players.reduce((sum, p) => sum + (p ? p.payout : 0), 0);
  }
  const human = round.players.find((p) => p && p.isHuman);
  return human ? human.payout : 0;
}
