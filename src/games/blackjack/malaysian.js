/**
 * Malaysian Blackjack (Ban Luck): one round against a single fresh deck.
 *
 * No hole card, no double, no split, no surrender, no insurance — the whole
 * round is the player's hand against the dealer's. Specials are checked on
 * the first two cards on both sides the instant they are dealt: Ban Ban (a
 * pair of aces) pays 3:1, Ban Luck (ace + a ten-value card) pays 2:1. A
 * dealer special ends the round at once — the player loses at that multiple
 * unless holding an equal-or-better special of their own (ties push, and Ban
 * Ban outranks Ban Luck); a player special with no dealer special is paid
 * immediately. 777 (three sevens) pays 7:1, and Five Dragon — five cards
 * totalling 21 or less — wins at once, 2:1 normally or 3:1 on exactly 21. The
 * player needs at least 16 to stand, may hit up to five cards, and a bust
 * loses outright regardless of what the dealer draws afterwards. The dealer
 * draws below 16 and stands from 16, and a dealer five-card 21-or-under beats
 * any non-special player at 2:1.
 */

import { drawCard, isAce, isTenValue, malaysianTotal } from './cards.js';

const SPECIAL_MULTIPLE = { banluck: 2, banban: 3 };
const SPECIAL_RANK = { banluck: 1, banban: 2 };

function detectSpecial(cards) {
  if (cards.length !== 2) return null;
  const aces = cards.filter(isAce).length;
  if (aces === 2) return 'banban';
  if (aces === 1 && cards.some(isTenValue)) return 'banluck';
  return null;
}

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

  const round = { variant: 'malaysian', bet, player, dealer, phase: 'player', settled: false };
  player.special = detectSpecial(player.cards);
  dealer.special = detectSpecial(dealer.cards);

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
