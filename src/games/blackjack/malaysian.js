/**
 * Malaysian Blackjack (Ban Luck): the player seat, and the dealer seat.
 *
 * PLAYER SEAT (startRound..roundNet): one round against a single fresh deck.
 * No hole card, no double, no split, no surrender, no insurance — the whole
 * round is the player's hand against the dealer's. Specials are checked on
 * the first two cards on both sides the instant they are dealt: Ban Ban (a
 * pair of aces) pays 3:1, Ban Luck (ace + a ten-value card) pays 2:1. A
 * dealer special ends the round at once — the player loses at that multiple
 * unless holding an equal-or-better special of their own (ties push, and Ban
 * Ban outranks Ban Luck); a player special with no dealer special is paid
 * immediately. 777 (three sevens) pays 7:1, and Five Dragon — five cards
 * totalling 21 or less — wins at once, 2:1 normally or 3:1 on exactly 21. On
 * an opening two-card 15 (ace-high, so A+4 counts), Run ends the hand at once
 * as a push and returns the bet — the dealer never plays that hand out. Run
 * takes precedence over a dealer special too: holding a Ban Ban does not
 * pre-empt a hand that can still run — the dealer's special is held back
 * until the player either runs (a push regardless of what the dealer holds)
 * or takes any other action, at which point it resolves at once (a special
 * hand is always 21, so this can never coincide with a player special of its
 * own). The player needs at least 16 to stand otherwise, may hit up to five cards, and
 * a bust loses outright regardless of what the dealer draws afterwards. The
 * dealer draws below 16 and stands from 16, and a dealer five-card 21-or-under
 * beats any non-special player at 2:1.
 *
 * DEALER SEAT (startDealerSeatRound..dealerSeatNet): the human deals against
 * four bots, each with their own bet; the human's bankroll is the house.
 * Cards round-robin two at a time (bots in seat order, then the dealer) —
 * the bots' cards are dealt face down and only the human dealer's choice to
 * open a bot reveals them. Every bot with an opening two-card 15 decides Run
 * first, before anything else at the deal — the same precedence the player
 * seat follows — so a bot that runs pushes even if the dealer turns out to
 * hold a special. Specials at the deal then resolve exactly as the player
 * seat's do, generalised to four hands: a bot special pays out immediately
 * unless the dealer also holds a special, in which case the dealer's special
 * ends the round at once and every bot still standing is settled against it
 * (push at an equal-or-better special, otherwise a loss at the dealer's
 * multiple) — a bot that already ran is untouched by it either way. Bots
 * then act in seat order for whatever is left — Hit or Stand, needing 16 to
 * stand, five cards being the ceiling — with 777 and Five Dragon paid the
 * instant they are made, same as the player seat. A bot bust is not revealed:
 * its turn simply ends, face down, and its fate waits for the dealer to open
 * it. Once every bot has acted, the human dealer hits (never below 16, up to
 * five cards) and opens bots at will once at 16 or more; each opening
 * compares the bot's hand with the dealer's total *at that moment*, so a
 * draw between two openings only changes the comparison for the ones after
 * it. Reaching five cards at 21-or-under (the dealer's own Five Dragon) or
 * three 7s (777) settles every still-unopened bot at once, at 2:1 (3:1 on
 * exactly 21) or 7:1 — a bot's own five-card hand or special was already
 * resolved during its turn, so this only ever touches hands that were still
 * pending. A dealer bust settles every still-unopened bot as their win,
 * *except* a bot that had busted itself, which pushes (both sides went over).
 * A bust — the dealer's or a bot's — is always a flat loss of the bet, never
 * scaled by whatever multiple the winning side's special would otherwise pay;
 * busting is its own fixed penalty, the same principle the player seat uses
 * ("a bust loses outright").
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

// ---------------------------------------------------------------------------
// Player seat
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {object[]} args.deck  drawn from with drawCard(); a fresh 52-card shuffle
 * @param {number} args.bet
 */
export function startRound({ deck, bet }) {
  const player = { cards: [], bet, special: null, busted: false, stood: false, result: null, payout: 0 };
  const dealer = { cards: [], special: null };
  player.cards.push(drawCard(deck));
  dealer.cards.push(drawCard(deck));
  player.cards.push(drawCard(deck));
  dealer.cards.push(drawCard(deck));

  const round = {
    variant: 'malaysian', bet, player, dealer, phase: 'player', settled: false, dealerSpecialPending: false,
  };
  player.special = detectSpecial(player.cards);
  dealer.special = detectSpecial(dealer.cards);

  // Run gets first refusal: on an opening 15, the player decides run or not
  // before the dealer's own special is revealed or applied — even a Ban Ban
  // does not pre-empt a hand that can still run. Holding it back here is what
  // canRun/run/hit key off below; a special hand is always 21, never 15, so
  // this can never coincide with a player special.
  if (dealer.special && player.cards.length === 2 && malaysianTotal(player.cards).total === 15) {
    round.dealerSpecialPending = true;
    return round;
  }
  if (dealer.special) {
    resolveDealerSpecial(round);
    return round;
  }
  if (player.special) {
    player.result = player.special;
    player.payout = bet * SPECIAL_MULTIPLE[player.special];
    round.phase = 'settled';
    round.settled = true;
    return round;
  }
  return round;
}

function resolveDealerSpecial(round) {
  const p = round.player;
  const dealerRank = SPECIAL_RANK[round.dealer.special];
  const playerRank = p.special ? SPECIAL_RANK[p.special] : 0;
  if (playerRank === dealerRank) {
    p.result = 'push';
    p.payout = 0;
  } else if (playerRank > dealerRank) {
    p.result = p.special;
    p.payout = round.bet * SPECIAL_MULTIPLE[p.special];
  } else {
    p.result = 'lose';
    p.payout = -round.bet * SPECIAL_MULTIPLE[round.dealer.special];
  }
  round.phase = 'settled';
  round.settled = true;
}

export function canHit(round) {
  return round.phase === 'player' && !round.player.busted && !round.player.stood && round.player.cards.length < 5;
}

export function hit(round, deck) {
  if (!canHit(round)) return { ok: false, error: 'cannot hit' };
  if (round.dealerSpecialPending) {
    // Hitting is how an opening 15 declines Run — the dealer's held-back
    // special resolves the round right here, at once, and no card is drawn.
    round.dealerSpecialPending = false;
    resolveDealerSpecial(round);
    return { ok: true };
  }
  const p = round.player;
  p.cards.push(drawCard(deck));

  if (p.cards.length === 3 && p.cards.every((c) => c.rank === 7)) {
    p.result = '777';
    p.payout = round.bet * 7;
    round.phase = 'settled';
    round.settled = true;
    return { ok: true };
  }

  const { total } = malaysianTotal(p.cards);
  if (total > 21) {
    p.busted = true;
    p.result = 'bust';
    p.payout = -round.bet;
    round.phase = 'settled';
    round.settled = true;
    return { ok: true };
  }

  if (p.cards.length === 5) {
    p.result = 'five-dragon';
    p.payout = round.bet * (total === 21 ? 3 : 2);
    round.phase = 'settled';
    round.settled = true;
  }
  return { ok: true };
}

/** Stand is disabled below 16 — the house rule that gives the game its edge. */
export function canStand(round) {
  if (round.phase !== 'player' || round.player.busted || round.player.stood) return false;
  return malaysianTotal(round.player.cards).total >= 16;
}

export function stand(round) {
  if (!canStand(round)) return { ok: false, error: 'need at least 16 to stand' };
  round.player.stood = true;
  round.phase = 'dealer';
  return { ok: true };
}

/** Run: only on the opening two cards, and only at exactly 15. Ends the hand
 * at once as a push — the bet comes straight back, and the dealer never
 * plays this hand out (unlike a stand, which hands off to playDealer()). */
export function canRun(round) {
  return round.phase === 'player' && round.player.cards.length === 2
    && malaysianTotal(round.player.cards).total === 15;
}

export function run(round) {
  if (!canRun(round)) return { ok: false, error: 'run is only offered on an opening 15' };
  round.player.result = 'run';
  round.player.payout = 0;
  round.phase = 'settled';
  round.settled = true;
  // A push either way — the dealer's held-back special (if any) never gets
  // the chance to apply.
  round.dealerSpecialPending = false;
  return { ok: true };
}

export function playDealer(round, deck) {
  const d = round.dealer;
  while (malaysianTotal(d.cards).total < 16 && d.cards.length < 5) {
    d.cards.push(drawCard(deck));
  }
  settle(round);
  round.phase = 'settled';
  round.settled = true;
  return round;
}

function settle(round) {
  const p = round.player;
  const dealerTotal = malaysianTotal(round.dealer.cards);
  const playerTotal = malaysianTotal(p.cards);

  if (round.dealer.cards.length === 5 && dealerTotal.total <= 21) {
    // A dealer Five Dragon beats any hand that did not answer with a special
    // of its own — the player already checked out through startRound() if
    // they had one.
    p.result = 'lose';
    p.payout = -round.bet * 2;
    return;
  }
  if (dealerTotal.total > 21) { p.result = 'win'; p.payout = round.bet; return; }
  if (playerTotal.total > dealerTotal.total) { p.result = 'win'; p.payout = round.bet; } else if (playerTotal.total < dealerTotal.total) { p.result = 'lose'; p.payout = -round.bet; } else { p.result = 'push'; p.payout = 0; }
}

export function roundNet(round) {
  return round.player.payout;
}

// ---------------------------------------------------------------------------
// Dealer seat: the human deals against four bots
// ---------------------------------------------------------------------------

export const BOT_NAMES = ['Azman', 'Bee', 'Chandra', 'Farid'];
export const DEALER_SEAT_BOTS = BOT_NAMES.length;

/** 4 bots, each capable of pulling a 7:1 777 against the house at once —
 * the bankroll has to survive that worst case to sit down as dealer. */
export function dealerSeatBankrollRequirement(table) {
  return table.max * DEALER_SEAT_BOTS * 7;
}

export function canPlayDealerSeat(table, bankroll) {
  return bankroll >= dealerSeatBankrollRequirement(table);
}

/** A bet within the table's ladder, always a multiple of its minimum —
 * the same denominations a human would be offered at this table. */
export function randomBotBet(table, rng) {
  const steps = Math.floor((table.max - table.min) / table.min) + 1;
  return table.min + Math.floor(rng() * steps) * table.min;
}

/**
 * A bot's decision on its turn: 'run' (opening 15 only), 'hit' or 'stand'.
 * Deliberately simple and documented rather than optimal:
 *  - Below 16 (and not an opening 15) it always hits — it has no choice, the
 *    same floor the human player and the human dealer both play under.
 *  - An opening 15 runs about half the time; more (70%) against a dealer
 *    already showing a strong two-card total (18+), where pushing the
 *    guaranteed bet back is worth more than a hand unlikely to beat what's
 *    already on the table.
 *  - At 16-17 with four cards or fewer, it keeps drawing for a shot at Five
 *    Dragon about a third of the time — standing at 16-17 is a near-certain
 *    loss once the dealer opens it, so chasing the 2:1/3:1 is worth the bust
 *    risk while there are still cards left to draw.
 *  - Anything else (18+, or no more room to chase Five Dragon) stands.
 */
function wantsToRun(cards, dealerCards, rng) {
  const dealerStrong = malaysianTotal(dealerCards).total >= 18;
  const runChance = dealerStrong ? 0.7 : 0.5;
  return rng() < runChance;
}

export function botDecide(cards, dealerCards, rng) {
  const { total } = malaysianTotal(cards);
  if (cards.length === 2 && total === 15) {
    return wantsToRun(cards, dealerCards, rng) ? 'run' : 'hit';
  }
  if (total < 16) return 'hit';
  if (total <= 17 && cards.length <= 4) {
    return rng() < (1 / 3) ? 'hit' : 'stand';
  }
  return 'stand';
}

/** Run gets first refusal for every bot, before anything about the dealer's
 * own hand is applied — the same precedence the player seat follows. A bot
 * that runs is opened (a push, cards.length still 2) and is untouched by
 * whatever the dealer turns out to hold; a bot that declines is marked
 * runDeclined so its later turn (playBotTurn) does not ask again. */
function decideOpeningRuns(round, rng) {
  for (const bot of round.bots) {
    if (bot.special) continue; // a special hand is always 21, never 15
    if (bot.cards.length === 2 && malaysianTotal(bot.cards).total === 15) {
      if (wantsToRun(bot.cards, round.dealer.cards, rng)) {
        bot.result = 'run';
        bot.payout = 0;
        bot.opened = true;
        bot.actions = ['run'];
      } else {
        bot.runDeclined = true;
      }
    }
  }
}

function finishDealerPhaseIfDone(round) {
  if (round.phase === 'dealer' && round.bots.every((b) => b.opened)) {
    round.phase = 'settled';
    round.settled = true;
  }
}

function settleAllAtDealForDealerSpecial(round) {
  const dealerRank = SPECIAL_RANK[round.dealer.special];
  for (const bot of round.bots) {
    if (bot.opened) continue; // already settled by running, ahead of this
    const botRank = bot.special ? SPECIAL_RANK[bot.special] : 0;
    bot.opened = true;
    if (botRank >= dealerRank) { bot.result = 'push'; bot.payout = 0; } else {
      bot.result = 'lose';
      bot.payout = -bot.bet * SPECIAL_MULTIPLE[round.dealer.special];
    }
  }
  round.phase = 'settled';
  round.settled = true;
}

/**
 * @param {object} args
 * @param {object[]} args.deck   drawn from with drawCard()
 * @param {object} args.table    games/blackjack/tables.js entry (min/max)
 * @param {import('../../core/rng.js').Rng} args.rng
 */
export function startDealerSeatRound({ deck, table, rng }) {
  const bots = BOT_NAMES.map((name) => ({
    name,
    bet: randomBotBet(table, rng),
    cards: [],
    special: null,
    busted: false,
    stood: false,
    opened: false,
    result: null,
    payout: 0,
    actions: [],
    dealerTotalAtOpen: null,
    runDeclined: false,
  }));
  const dealer = { cards: [], special: null };

  // Round-robin, two cards each: bots in seat order, then the dealer, twice.
  for (let pass = 0; pass < 2; pass++) {
    for (const bot of bots) bot.cards.push(drawCard(deck));
    dealer.cards.push(drawCard(deck));
  }

  for (const bot of bots) bot.special = detectSpecial(bot.cards);
  dealer.special = detectSpecial(dealer.cards);

  const round = { variant: 'malaysian-dealer', table, bots, dealer, phase: 'bots', settled: false };

  // Every eligible bot decides Run before anything about the dealer's own
  // hand is revealed or applied.
  decideOpeningRuns(round, rng);

  if (dealer.special) {
    settleAllAtDealForDealerSpecial(round);
    return round;
  }
  for (const bot of bots) {
    if (bot.special) {
      bot.result = bot.special;
      bot.payout = bot.bet * SPECIAL_MULTIPLE[bot.special];
      bot.opened = true;
    }
  }
  round.phase = round.bots.every((b) => b.opened) ? 'dealer' : 'bots';
  finishDealerPhaseIfDone(round);
  return round;
}

/** Plays one bot's whole turn to a decision point (run, stand, a hidden
 * bust, or an instant 777/Five Dragon payout), logging each decision in
 * bot.actions so the UI can pace revealing them without knowing card faces
 * — everything here is face-down to the human dealer regardless. */
export function playBotTurn(round, botIndex, deck, rng) {
  const bot = round.bots[botIndex];
  if (!bot || bot.opened) return { ok: false, error: 'bot already resolved' };
  bot.actions = [];
  let first = true;
  for (;;) {
    // The run/no-run call for an opening 15 already happened in
    // decideOpeningRuns(), ahead of the dealer's own special — a bot that
    // declined it just takes the resulting hit, without being asked again.
    const decision = (first && bot.runDeclined) ? 'hit' : botDecide(bot.cards, round.dealer.cards, rng);
    first = false;
    bot.actions.push(decision);
    if (decision === 'run') {
      bot.result = 'run';
      bot.payout = 0;
      bot.opened = true;
      break;
    }
    if (decision === 'stand') {
      bot.stood = true;
      break;
    }
    bot.cards.push(drawCard(deck));
    if (bot.cards.length === 3 && bot.cards.every(isSeven)) {
      bot.result = '777';
      bot.payout = bot.bet * 7;
      bot.opened = true;
      break;
    }
    const t = malaysianTotal(bot.cards);
    if (t.total > 21) {
      bot.busted = true; // hidden — settled only once the dealer opens it
      break;
    }
    if (bot.cards.length === 5) {
      bot.result = 'five-dragon';
      bot.payout = bot.bet * (t.total === 21 ? 3 : 2);
      bot.opened = true;
      break;
    }
  }
  if (round.bots.every((b) => b.opened || b.busted || b.stood)) {
    round.phase = 'dealer';
    finishDealerPhaseIfDone(round);
  }
  return { ok: true };
}

export function canDealerHit(round) {
  return round.phase === 'dealer' && round.dealer.cards.length < 5;
}

function settleUnopenedOnDealerBust(round) {
  for (const bot of round.bots) {
    if (bot.opened) continue;
    bot.opened = true;
    if (bot.busted) { bot.result = 'push'; bot.payout = 0; } else { bot.result = 'win'; bot.payout = bot.bet; }
  }
  round.phase = 'settled';
  round.settled = true;
}

function settleUnopenedForDealerWin(round, multiple) {
  for (const bot of round.bots) {
    if (bot.opened) continue;
    bot.opened = true;
    bot.result = 'lose';
    // A bust is a flat loss of the bet, never scaled by the dealer's
    // winning multiple — the same "a bust loses outright" flatness the
    // player seat uses.
    bot.payout = bot.busted ? -bot.bet : -bot.bet * multiple;
  }
  round.phase = 'settled';
  round.settled = true;
}

export function dealerHit(round, deck) {
  if (!canDealerHit(round)) return { ok: false, error: 'cannot hit' };
  round.dealer.cards.push(drawCard(deck));
  const t = malaysianTotal(round.dealer.cards);
  if (t.total > 21) {
    settleUnopenedOnDealerBust(round);
  } else if (round.dealer.cards.length === 3 && round.dealer.cards.every(isSeven)) {
    settleUnopenedForDealerWin(round, 7);
  } else if (round.dealer.cards.length === 5) {
    settleUnopenedForDealerWin(round, t.total === 21 ? 3 : 2);
  }
  return { ok: true };
}

/** Nothing can be opened below 16 — the human dealer's own floor to stand. */
export function canOpenBot(round, botIndex) {
  const bot = round.bots[botIndex];
  if (round.phase !== 'dealer' || !bot || bot.opened) return false;
  return malaysianTotal(round.dealer.cards).total >= 16;
}

/** Opens one bot against the dealer's *current* total — drawing more cards
 * after this only changes what the next opening compares against. */
export function openBot(round, botIndex) {
  if (!canOpenBot(round, botIndex)) return { ok: false, error: 'cannot open this hand yet' };
  const bot = round.bots[botIndex];
  const dealerTotal = malaysianTotal(round.dealer.cards).total;
  bot.opened = true;
  bot.dealerTotalAtOpen = dealerTotal;
  if (bot.busted) {
    bot.result = 'lose';
    bot.payout = -bot.bet;
  } else {
    const botTotal = malaysianTotal(bot.cards).total;
    if (botTotal > dealerTotal) { bot.result = 'win'; bot.payout = bot.bet; } else if (botTotal < dealerTotal) { bot.result = 'lose'; bot.payout = -bot.bet; } else { bot.result = 'push'; bot.payout = 0; }
  }
  if (round.bots.every((b) => b.opened)) {
    round.phase = 'settled';
    round.settled = true;
  }
  return { ok: true };
}

/** The dealer's net this round: the sum of every bot's payout, negated —
 * a bot's win is a payment out of the house (the human's bankroll). */
export function dealerSeatNet(round) {
  return -round.bots.reduce((sum, b) => sum + b.payout, 0);
}
