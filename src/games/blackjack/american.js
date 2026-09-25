/**
 * American Blackjack: one round against a six-deck shoe.
 *
 * Dealer stands on all 17s (soft included), blackjack pays 3:2, the dealer
 * peeks for blackjack whenever showing an ace or a ten, insurance is offered
 * only on an ace and pays 2:1, doubling is open on any first two cards
 * (including after a split), a pair may split up to three times for four
 * hands, split aces get exactly one card each and can never be resplit or
 * count as blackjack, and late surrender is only on the original two cards.
 *
 * A round is a plain object mutated in place, mirroring the style of
 * games/doudizhu/engine.js: functions return {ok:true, ...} or
 * {ok:false, error}. Nothing here touches the DOM or the clock — the UI
 * layer paces the animation, this only tracks what happened.
 */

import { americanTotal, baseValue, drawCard, isAce, isNaturalBlackjack, isTenValue } from './cards.js';

export const MAX_SPLITS = 3; // three splits = four hands

function newHand(bet, overrides = {}) {
  return {
    cards: [],
    bet,
    doubled: false,
    fromSplit: false,
    isSplitAces: false,
    blackjack: false,
    stood: false,
    busted: false,
    surrendered: false,
    result: null,
    payout: 0,
    ...overrides,
  };
}

function current(round) {
  return round.hands[round.activeHand];
}

function isHandDone(hand) {
  return hand.stood || hand.busted || hand.surrendered;
}

/** Skip forward to the next hand that still needs a decision, or the dealer. */
function advance(round) {
  while (round.activeHand < round.hands.length && isHandDone(round.hands[round.activeHand])) {
    round.activeHand += 1;
  }
  if (round.activeHand >= round.hands.length) round.phase = 'dealer';
}

function dealerHasBlackjack(round) {
  return isNaturalBlackjack(round.dealer.cards);
}

/** Look at the hole card. Only called when the up card allows a blackjack. */
function peek(round) {
  if (dealerHasBlackjack(round)) {
    round.dealerBlackjack = true;
    round.dealer.holeHidden = false;
  }
}

/** After the initial deal (and any insurance decision) settles what happens next. */
function afterPeek(round, shoe) {
  if (round.dealerBlackjack) {
    round.phase = 'dealer';
    playDealer(round, shoe);
    return;
  }
  if (round.hands[0].blackjack) {
    // A natural on the player's side with no dealer blackjack: paid at once,
    // nothing left to hit, and the dealer need not draw beyond its two cards.
    round.phase = 'dealer';
    playDealer(round, shoe);
    return;
  }
  round.phase = 'player';
}

/**
 * @param {object} args
 * @param {object} args.shoe   from cards.js createShoe()
 * @param {number} args.bet
 */
export function startRound({ shoe, bet }) {
  const hand = newHand(bet);
  const dealer = { cards: [], holeHidden: true };
  hand.cards.push(drawCard(shoe));
  dealer.cards.push(drawCard(shoe));
  hand.cards.push(drawCard(shoe));
  dealer.cards.push(drawCard(shoe));
  hand.blackjack = isNaturalBlackjack(hand.cards);

  const round = {
    variant: 'american',
    hands: [hand],
    activeHand: 0,
    dealer,
    phase: 'player',
    insuranceOffered: false,
    insuranceBet: 0,
    insurancePayout: 0,
    dealerBlackjack: false,
    splitCount: 0,
    settled: false,
  };

  const upCard = dealer.cards[0];
  if (isAce(upCard)) {
    round.phase = 'insurance';
    round.insuranceOffered = true;
    return round;
  }
  if (isTenValue(upCard)) peek(round);
  afterPeek(round, shoe);
  return round;
}

/**
 * @param {boolean} wantInsurance
 */
export function decideInsurance(round, shoe, wantInsurance) {
  if (round.phase !== 'insurance') return { ok: false, error: 'insurance is not on offer' };
  round.insuranceOffered = false;
  round.insuranceBet = wantInsurance ? round.hands[0].bet / 2 : 0;
  peek(round);
  afterPeek(round, shoe);
  return { ok: true };
}

export function canHit(round) {
  const hand = current(round);
  return round.phase === 'player' && !!hand && !isHandDone(hand) && !hand.isSplitAces;
}

export function hit(round, shoe) {
  if (!canHit(round)) return { ok: false, error: 'cannot hit this hand' };
  const hand = current(round);
  hand.cards.push(drawCard(shoe));
  const { total } = americanTotal(hand.cards);
  if (total > 21) hand.busted = true;
  else if (total === 21) hand.stood = true; // nothing left worth hitting for
  advance(round);
  return { ok: true };
}

export function canStand(round) {
  const hand = current(round);
  return round.phase === 'player' && !!hand && !isHandDone(hand);
}

export function stand(round) {
  if (!canStand(round)) return { ok: false, error: 'cannot stand on this hand' };
  current(round).stood = true;
  advance(round);
  return { ok: true };
}

export function canDouble(round) {
  const hand = current(round);
  return round.phase === 'player' && !!hand && !isHandDone(hand)
    && hand.cards.length === 2 && !hand.isSplitAces;
}

export function double(round, shoe) {
  if (!canDouble(round)) return { ok: false, error: 'cannot double this hand' };
  const hand = current(round);
  hand.doubled = true;
  hand.bet *= 2;
  hand.cards.push(drawCard(shoe));
  const { total } = americanTotal(hand.cards);
  hand.stood = true;
  if (total > 21) hand.busted = true;
  advance(round);
  return { ok: true };
}

export function canSplit(round) {
  const hand = current(round);
  if (round.phase !== 'player' || !hand || isHandDone(hand)) return false;
  if (hand.cards.length !== 2 || hand.isSplitAces) return false;
  if (round.splitCount >= MAX_SPLITS) return false;
  // Grouped by blackjack value, so a queen and a king may split together.
  return baseValue(hand.cards[0]) === baseValue(hand.cards[1]);
}

export function split(round, shoe) {
  if (!canSplit(round)) return { ok: false, error: 'cannot split this hand' };
  const hand = current(round);
  const aceSplit = isAce(hand.cards[0]);
  const [c1, c2] = hand.cards;
  const h1 = newHand(hand.bet, { cards: [c1], fromSplit: true, isSplitAces: aceSplit });
  const h2 = newHand(hand.bet, { cards: [c2], fromSplit: true, isSplitAces: aceSplit });
  round.hands.splice(round.activeHand, 1, h1, h2);
  round.splitCount += 1;
  h1.cards.push(drawCard(shoe));
  h2.cards.push(drawCard(shoe));
  if (aceSplit) {
    // One card each, then the hand is done — never a blackjack, never resplit.
    h1.stood = true;
    h2.stood = true;
  } else {
    if (americanTotal(h1.cards).total === 21) h1.stood = true;
    if (americanTotal(h2.cards).total === 21) h2.stood = true;
  }
  advance(round);
  return { ok: true };
}

export function canSurrender(round) {
  const hand = current(round);
  return round.phase === 'player' && !!hand && !isHandDone(hand)
    && round.hands.length === 1 && round.splitCount === 0 && hand.cards.length === 2;
}

export function surrender(round) {
  if (!canSurrender(round)) return { ok: false, error: 'cannot surrender now' };
  current(round).surrendered = true;
  advance(round);
  return { ok: true };
}

/** True while any hand's outcome still depends on the dealer completing theirs. */
function dealerMustPlayOn(round) {
  return round.hands.some((h) => !h.busted && !h.surrendered && !(h.blackjack && !h.fromSplit));
}

export function playDealer(round, shoe) {
  round.dealer.holeHidden = false;
  if (!round.dealerBlackjack && dealerMustPlayOn(round)) {
    // Stands on all 17s, hard or soft.
    while (americanTotal(round.dealer.cards).total < 17) {
      round.dealer.cards.push(drawCard(shoe));
    }
  }
  settle(round);
  round.phase = 'settled';
  return round;
}

function settle(round) {
  const dealerTotal = americanTotal(round.dealer.cards);
  const dealerBJ = round.dealerBlackjack;

  for (const hand of round.hands) {
    if (hand.surrendered) {
      hand.result = 'surrender';
      hand.payout = -hand.bet / 2;
      continue;
    }
    if (hand.busted) {
      hand.result = 'bust';
      hand.payout = -hand.bet;
      continue;
    }
    if (dealerBJ) {
      if (hand.blackjack) { hand.result = 'push'; hand.payout = 0; } else { hand.result = 'lose'; hand.payout = -hand.bet; }
      continue;
    }
    if (hand.blackjack && !hand.fromSplit) {
      hand.result = 'blackjack';
      hand.payout = hand.bet * 1.5;
      continue;
    }
    const total = americanTotal(hand.cards).total;
    if (dealerTotal.bust) { hand.result = 'win'; hand.payout = hand.bet; } else if (total > dealerTotal.total) { hand.result = 'win'; hand.payout = hand.bet; } else if (total < dealerTotal.total) { hand.result = 'lose'; hand.payout = -hand.bet; } else { hand.result = 'push'; hand.payout = 0; }
  }

  round.insurancePayout = round.insuranceBet > 0 ? (dealerBJ ? round.insuranceBet * 2 : -round.insuranceBet) : 0;
  round.settled = true;
}

/** Total chips changing hands this round: every hand's payout plus insurance. */
export function roundNet(round) {
  return round.hands.reduce((sum, h) => sum + h.payout, 0) + (round.insurancePayout ?? 0);
}
