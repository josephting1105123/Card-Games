import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRng } from '../src/core/rng.js';
import {
  americanTotal, createShoe, isNaturalBlackjack, malaysianTotal, needsReshuffle, reshuffleShoe,
} from '../src/games/blackjack/cards.js';
import * as US from '../src/games/blackjack/american.js';
import * as MY from '../src/games/blackjack/malaysian.js';

// Ranks use core/cards.js's own numbering: 3..10 numeric, J=11, Q=12, K=13,
// A=14, 2=15. Suit never matters to blackjack value, so every test card is a
// spade; only the rank (and, for the shoe, a unique id) is real.
const A = 14, K = 13, Q = 12, J = 11, TWO = 15;
let uid = 0;
function C(rank) { return { id: uid++, rank, suit: 'spade' }; }
/** A shoe/deck stacked in exactly the order given, for deterministic rounds. */
function stack(...ranks) { return { cards: ranks.map(C), dealt: 0 }; }

// ---------------------------------------------------------------------------
// Hand totals
// ---------------------------------------------------------------------------

test('american total: hard, soft, and bust', () => {
  assert.equal(americanTotal([C(10), C(7)]).total, 17);
  assert.equal(americanTotal([C(10), C(7)]).soft, false);

  const soft17 = americanTotal([C(A), C(6)]);
  assert.equal(soft17.total, 17);
  assert.equal(soft17.soft, true, 'an ace still counted as 11 is a soft hand');

  const demoted = americanTotal([C(A), C(A), C(9)]);
  assert.equal(demoted.total, 21, 'one ace demotes to 1 to avoid busting, the other stays 11');
  assert.equal(demoted.soft, true);

  const bust = americanTotal([C(10), C(9), C(5)]);
  assert.equal(bust.total, 24);
  assert.equal(bust.bust, true);

  assert.equal(isNaturalBlackjack([C(A), C(K)]), true);
  assert.equal(isNaturalBlackjack([C(7), C(A), C(3)]), false, 'blackjack is only the first two cards');
});

test('malaysian total: the ace pair changes with the hand length', () => {
  assert.equal(malaysianTotal([C(A), C(5)]).total, 16, '2-card: 11 preferred when it does not bust');
  assert.equal(malaysianTotal([C(A), C(A)]).total, 21, '2-card: one ace demotes to 10 to dodge the bust');
  assert.equal(malaysianTotal([C(A), C(9), C(5)]).total, 15, '3-card: 10 busts, so the ace falls to 1');
  assert.equal(malaysianTotal([C(A), C(2), C(2)]).total, 14, '3-card: 10 fits, so it is used');
  assert.equal(malaysianTotal([C(A), C(2), C(2), C(2), C(2)]).total, 9, '4/5-card: the ace is always 1');
});

// ---------------------------------------------------------------------------
// American: dealer stands on all 17s
// ---------------------------------------------------------------------------

test('american: dealer stands on a soft 17, does not hit past it', () => {
  const shoe = stack(10, 6, 9, A); // player 10, dealer-up 6, player 9, dealer-hole A
  const round = US.startRound({ shoe, bet: 100 });
  assert.equal(round.phase, 'player');
  US.stand(round);
  assert.equal(round.phase, 'dealer');
  US.playDealer(round, shoe);
  assert.deepEqual(round.dealer.cards.map((c) => c.rank), [6, A], 'no third card drawn');
  const total = americanTotal(round.dealer.cards);
  assert.equal(total.total, 17);
  assert.equal(total.soft, true);
  assert.equal(round.hands[0].result, 'win');
});

// ---------------------------------------------------------------------------
// American: blackjack pays 3:2
// ---------------------------------------------------------------------------

test('american: a natural blackjack pays 3:2 and the dealer does not draw further', () => {
  const shoe = stack(A, 5, K, 4); // player A,K = blackjack; dealer up 5 (no peek), hole 4
  const round = US.startRound({ shoe, bet: 100 });
  assert.equal(round.hands[0].blackjack, true);
  assert.equal(round.phase, 'settled', 'nothing left to hit on a natural');
  assert.equal(round.dealer.cards.length, 2, 'the dealer does not draw past a natural');
  assert.equal(round.hands[0].result, 'blackjack');
  assert.equal(round.hands[0].payout, 150);
});

// ---------------------------------------------------------------------------
// American: insurance
// ---------------------------------------------------------------------------

test('american: insurance pays 2:1 and exactly offsets a dealer blackjack', () => {
  const shoe = stack(9, A, 8, K); // player 9,8=17; dealer up A, hole K = dealer blackjack
  const round = US.startRound({ shoe, bet: 100 });
  assert.equal(round.phase, 'insurance');
  US.decideInsurance(round, shoe, true);
  assert.equal(round.dealerBlackjack, true);
  assert.equal(round.phase, 'settled');
  assert.equal(round.insuranceBet, 50);
  assert.equal(round.insurancePayout, 100);
  assert.equal(round.hands[0].result, 'lose');
  assert.equal(round.hands[0].payout, -100);
  assert.equal(US.roundNet(round), 0, 'insurance exactly covers the lost main bet');
});

test('american: declining insurance loses the full bet to a dealer blackjack', () => {
  const shoe = stack(9, A, 8, K);
  const round = US.startRound({ shoe, bet: 100 });
  US.decideInsurance(round, shoe, false);
  assert.equal(round.insuranceBet, 0);
  assert.equal(round.insurancePayout, 0);
  assert.equal(US.roundNet(round), -100);
});

test('american: dealer peeks on a ten upcard too, without offering insurance', () => {
  const shoe = stack(9, K, 8, A); // dealer up K, hole A = dealer blackjack, no insurance offer
  const round = US.startRound({ shoe, bet: 100 });
  assert.notEqual(round.phase, 'insurance');
  assert.equal(round.dealerBlackjack, true);
  assert.equal(round.phase, 'settled');
  assert.equal(round.hands[0].result, 'lose');
});

// ---------------------------------------------------------------------------
// American: split, resplit limit, split aces
// ---------------------------------------------------------------------------

test('american: a pair may split up to three times into four hands', () => {
  const shoe = stack(8, 4, 8, 3, 8, 9, 8, 9, 9, 9);
  const round = US.startRound({ shoe, bet: 10 });
  assert.equal(US.canSplit(round), true);
  US.split(round, shoe);
  assert.equal(round.splitCount, 1);
  US.split(round, shoe);
  assert.equal(round.splitCount, 2);
  US.split(round, shoe);
  assert.equal(round.splitCount, 3);
  assert.equal(round.hands.length, 4, 'three splits make four hands');
  assert.equal(US.canSplit(round), false, 'splitCount has hit the limit');
});

test('american: cannot split past the limit, even holding a fresh pair', () => {
  const round = { phase: 'player', activeHand: 0, splitCount: US.MAX_SPLITS, hands: [
    { cards: [C(8), C(8)], stood: false, busted: false, surrendered: false, isSplitAces: false },
  ] };
  assert.equal(US.canSplit(round), false);
});

test('american: split aces get one card each, cannot resplit, and 21 is not blackjack', () => {
  const shoe = stack(A, 2, A, 5, K, 9, 10);
  const round = US.startRound({ shoe, bet: 100 });
  US.split(round, shoe);
  const [h1, h2] = round.hands;
  assert.equal(h1.isSplitAces, true);
  assert.equal(h1.stood, true, 'one card, then done');
  assert.equal(h1.cards.length, 2);
  assert.equal(americanTotal(h1.cards).total, 21);
  assert.equal(h1.blackjack, false, '21 on a split ace is 21, not blackjack');
  assert.equal(US.canHit(round), false);
  assert.equal(US.canSplit(round), false, 'a split-ace hand cannot be resplit');
  assert.equal(round.phase, 'dealer');
  US.playDealer(round, shoe);
  assert.equal(h1.result, 'win');
  assert.equal(h1.payout, 100, 'even money, not the 1.5x blackjack pays');
  assert.equal(h2.result, 'win');
});

test('american: double after split is allowed', () => {
  const shoe = stack(8, 4, 8, 3, 8, 5, 6, 7);
  const round = US.startRound({ shoe, bet: 10 });
  US.split(round, shoe);
  const hand = round.hands[round.activeHand];
  assert.equal(hand.cards.length, 2);
  assert.equal(US.canDouble(round), true);
  US.double(round, shoe);
  assert.equal(hand.doubled, true);
  assert.equal(hand.bet, 20);
});

// ---------------------------------------------------------------------------
// American: surrender
// ---------------------------------------------------------------------------

test('american: late surrender loses half the bet, and only on the original two cards', () => {
  const shoe = stack(9, 6, 7, 9);
  const round = US.startRound({ shoe, bet: 100 });
  assert.equal(US.canSurrender(round), true);
  US.surrender(round);
  assert.equal(round.phase, 'dealer');
  US.playDealer(round, shoe);
  assert.equal(round.hands[0].result, 'surrender');
  assert.equal(round.hands[0].payout, -50);
});

test('american: surrender is not offered after a split', () => {
  const shoe = stack(8, 4, 8, 3, 9, 9);
  const round = US.startRound({ shoe, bet: 10 });
  US.split(round, shoe);
  assert.equal(US.canSurrender(round), false);
});

// ---------------------------------------------------------------------------
// American: shoe reshuffle point
// ---------------------------------------------------------------------------

test('american: the shoe calls for a reshuffle once 75% is dealt', () => {
  const shoe = createShoe(6, makeRng('shoe-seed'));
  assert.equal(shoe.size, 6 * 52);
  shoe.dealt = Math.ceil(shoe.size * 0.75) - 1;
  assert.equal(needsReshuffle(shoe), false);
  shoe.dealt += 1;
  assert.equal(needsReshuffle(shoe), true);
  reshuffleShoe(shoe, makeRng('shoe-seed-2'));
  assert.equal(shoe.dealt, 0);
  assert.equal(shoe.size, 6 * 52);
  assert.equal(needsReshuffle(shoe), false);
});

test('american: the same seed always builds the same shoe', () => {
  const a = createShoe(6, makeRng('repeat'));
  const b = createShoe(6, makeRng('repeat'));
  assert.deepEqual(a.cards.map((c) => c.id), b.cards.map((c) => c.id));
});

// ---------------------------------------------------------------------------
// Malaysian: the merged table. `startTableRound` takes up to four seats (any
// may be null/empty, a bot, or the human) plus a banker who is either the
// human or a bot; who actually controls the banker never changes the deal or
// settlement mechanics below — only tableRoundNet's sign cares — so most of
// these drive the banker directly (bankerHit/openSeat) exactly as a human
// banker's UI would, and the bot-only tests further down call bankerBotStep
// instead.
// ---------------------------------------------------------------------------

const table = { min: 100, max: 1000 };

/** A single human seat (seat 0), the other three empty — the shape the old
 * solo player-vs-house table always had. */
function soloSeats(bet = 100) {
  return [{ isHuman: true, bet }, null, null, null];
}
function soloRound(deck, bet = 100) {
  return MY.startTableRound({ deck, table, rng: () => 0, seats: soloSeats(bet), bankerIsHuman: false });
}

test('malaysian: Ban Ban (two aces) pays 3:1', () => {
  const deck = stack(A, 9, A, 4); // seat0 A,A = Ban Ban; banker 9,4 = 13, no special
  const round = soloRound(deck);
  const p = round.players[0];
  assert.equal(p.special, 'banban');
  assert.equal(round.phase, 'settled');
  assert.equal(p.result, 'banban');
  assert.equal(p.payout, 300);
});

test('malaysian: Ban Luck (ace + ten-value) pays 2:1', () => {
  const deck = stack(A, 9, Q, 4); // seat0 A,Q = Ban Luck; banker 9,4 = 13
  const round = soloRound(deck);
  assert.equal(round.players[0].special, 'banluck');
  assert.equal(round.players[0].payout, 200);
});

test('malaysian: a banker special ends the round at once and beats a plain hand', () => {
  const deck = stack(9, A, 5, Q); // seat0 9,5 = 14, no special; banker A,Q = Ban Luck
  const round = soloRound(deck);
  const p = round.players[0];
  assert.equal(round.phase, 'settled');
  assert.equal(round.banker.special, 'banluck');
  assert.equal(p.result, 'lose');
  assert.equal(p.payout, -200);
});

test("malaysian: a strictly better special beats the banker's, and an equal one pushes", () => {
  const winDeck = stack(A, A, A, K); // seat0 A,A = Ban Ban; banker A,K = Ban Luck
  const win = soloRound(winDeck);
  assert.equal(win.players[0].result, 'banban');
  assert.equal(win.players[0].payout, 300, "Ban Ban beats a Ban Luck banker, paid at its own multiple, not a push");

  const pushDeck = stack(A, A, K, Q); // both Ban Luck
  const push = soloRound(pushDeck);
  assert.equal(push.players[0].result, 'push');
  assert.equal(push.players[0].payout, 0);
});

test('malaysian: 777 pays 7:1', () => {
  const deck = stack(7, 2, 7, 3, 7); // seat0 7,7 then hits a third 7; banker 2,3
  const round = soloRound(deck);
  assert.equal(round.phase, 'players');
  MY.hitSeat(round, 0, deck);
  assert.equal(round.players[0].result, '777');
  assert.equal(round.players[0].payout, 700);
});

test('malaysian: Five Dragon wins at once, 2:1 normally and 3:1 on exactly 21', () => {
  const lowDeck = stack(TWO, 9, TWO, 9, TWO, TWO, TWO); // five 2s = 10
  const low = soloRound(lowDeck);
  MY.hitSeat(low, 0, lowDeck); MY.hitSeat(low, 0, lowDeck); MY.hitSeat(low, 0, lowDeck);
  assert.equal(malaysianTotal(low.players[0].cards).total, 10);
  assert.equal(low.players[0].result, 'five-dragon');
  assert.equal(low.players[0].payout, 200);

  const twentyOneDeck = stack(3, 9, 4, 9, 5, 6, 3); // 3+4+5+6+3 = 21
  const twentyOne = soloRound(twentyOneDeck);
  MY.hitSeat(twentyOne, 0, twentyOneDeck); MY.hitSeat(twentyOne, 0, twentyOneDeck); MY.hitSeat(twentyOne, 0, twentyOneDeck);
  assert.equal(twentyOne.players[0].result, 'five-dragon');
  assert.equal(twentyOne.players[0].payout, 300);
});

test('malaysian: stand is disabled below 16', () => {
  const deck = stack(9, 5, 5, 5, 5); // seat0 9,5 = 14
  const round = soloRound(deck);
  assert.equal(MY.canStandSeat(round, 0), false);
  MY.hitSeat(round, 0, deck); // +5 = 19
  assert.equal(MY.canStandSeat(round, 0), true);
});

test('malaysian: a seat bust stays hidden until the banker opens it, then loses the flat bet', () => {
  const deck = stack(K, 9, Q, 6, K, 2); // seat0 K,Q then hits K = 30, bust; banker 9,6 then hits a 2 = 17
  const round = soloRound(deck);
  MY.hitSeat(round, 0, deck);
  const p = round.players[0];
  assert.equal(p.busted, true);
  assert.equal(p.opened, false, 'hidden — a bust is not revealed until the banker opens it');
  assert.equal(round.phase, 'banker', 'nothing left to act on among the seats');
  assert.equal(round.banker.cards.length, 2, "the banker hasn't drawn yet");

  MY.bankerHit(round, deck);
  assert.equal(malaysianTotal(round.banker.cards).total, 17);
  assert.equal(MY.canOpenSeat(round, 0), true);
  MY.openSeat(round, 0);
  assert.equal(p.result, 'lose');
  assert.equal(p.payout, -100, "a bust is a flat loss of the bet, never scaled by the banker's own total");
  assert.equal(round.phase, 'settled');
});

// ---------------------------------------------------------------------------
// Malaysian: Run (a seat's opening 15)
// ---------------------------------------------------------------------------

test('malaysian: Run on an opening 15 pushes at once, including ace-high A+4', () => {
  const deck = stack(9, 5, 6, 4); // seat0 9,6 = 15
  const round = soloRound(deck);
  assert.equal(MY.canRunSeat(round, 0), true);
  MY.runSeat(round, 0);
  const p = round.players[0];
  assert.equal(p.result, 'run');
  assert.equal(p.payout, 0);
  assert.equal(round.phase, 'settled', 'only one seat, nothing left to do once it runs');
  assert.equal(round.banker.cards.length, 2, 'the banker never plays this hand out');

  const aceDeck = stack(A, 5, 4, 4); // seat0 A,4 = 15, ace counted high (11) on two cards
  const aceRound = soloRound(aceDeck);
  assert.equal(malaysianTotal(aceRound.players[0].cards).total, 15);
  assert.equal(MY.canRunSeat(aceRound, 0), true);
  MY.runSeat(aceRound, 0);
  assert.equal(aceRound.players[0].payout, 0);
});

test('malaysian: Run is not offered at 14, at 16, or once a card has been hit', () => {
  const at14 = soloRound(stack(9, 5, 5, 4)); // 9,5 = 14
  assert.equal(MY.canRunSeat(at14, 0), false);

  const at16 = soloRound(stack(9, 5, 7, 4)); // 9,7 = 16
  assert.equal(MY.canRunSeat(at16, 0), false);

  const deck = stack(6, 5, 9, 4, 2); // 6,9 = 15; hit draws a 2 -> 17
  const afterHit = soloRound(deck);
  assert.equal(MY.canRunSeat(afterHit, 0), true);
  MY.hitSeat(afterHit, 0, deck);
  assert.equal(MY.canRunSeat(afterHit, 0), false, 'run is only offered on the opening two cards');
});

test("malaysian: Run beats a bot banker's own special — running on 15 pushes even against Ban Luck", () => {
  const deck = stack(9, A, 6, Q); // seat0 9,6 = 15; banker A,Q = Ban Luck
  const round = soloRound(deck); // soloRound banks with bankerIsHuman:false — a bot-run banker
  const p = round.players[0];
  assert.equal(round.banker.special, 'banluck');
  assert.equal(round.phase, 'players', "the banker's special is held back while run is still on offer");
  assert.equal(p.bankerSpecialPending, true);
  assert.equal(MY.canRunSeat(round, 0), true);
  MY.runSeat(round, 0);
  assert.equal(p.result, 'run');
  assert.equal(p.payout, 0, "a push regardless of the banker's special");
  assert.equal(round.phase, 'settled');
});

test("malaysian: declining Run on 15 lets a bot banker's Ban Luck resolve the round at once, for -2x", () => {
  const deck = stack(9, A, 6, Q, 2); // same opening; the extra card must go unused
  const round = soloRound(deck);
  const p = round.players[0];
  assert.equal(MY.canRunSeat(round, 0), true);
  MY.hitSeat(round, 0, deck); // declines the run
  assert.equal(p.result, 'lose');
  assert.equal(p.payout, -200, "2:1 against the seat, the banker's Ban Luck multiple");
  assert.equal(round.phase, 'settled');
  assert.equal(p.cards.length, 2, "the banker's special pre-empted the hit — no card was drawn");
});

// ---------------------------------------------------------------------------
// Malaysian: the banker's own turn — draw/open mechanics, multi-seat
// ---------------------------------------------------------------------------

test("malaysian: opening compares against the banker's total at that moment, and a later draw only changes later openings", () => {
  const deck = stack(9, 9, 9, 9, 9, 7, 3); // two seats both 9,9 = 18; banker 9,7 = 16, then hits a 3 -> 19
  const round = MY.startTableRound({
    deck, table, rng: () => 0,
    seats: [{ isHuman: true, bet: 100 }, { isHuman: true, bet: 100 }, null, null],
    bankerIsHuman: false,
  });
  MY.standSeat(round, 0);
  MY.standSeat(round, 1);
  assert.equal(round.phase, 'banker');
  assert.equal(malaysianTotal(round.banker.cards).total, 16);

  assert.equal(MY.canOpenSeat(round, 0), true);
  MY.openSeat(round, 0); // 18 vs the banker's 16 -> seat0 wins
  assert.equal(round.players[0].result, 'win');
  assert.equal(round.players[0].bankerTotalAtOpen, 16);

  MY.bankerHit(round, deck); // 16 -> 19
  assert.equal(malaysianTotal(round.banker.cards).total, 19);
  assert.equal(round.players[0].result, 'win', "seat0's already-settled result is untouched by the later draw");
  assert.equal(round.players[0].payout, 100);

  MY.openSeat(round, 1); // seat1's 18 vs the banker's NEW total, 19 -> loses
  assert.equal(round.players[1].bankerTotalAtOpen, 19);
  assert.equal(round.players[1].result, 'lose');
  assert.equal(round.players[1].payout, -100);
  assert.equal(round.phase, 'settled');
});

test('malaysian: a banker bust pushes only the seats that busted themselves', () => {
  const deck = stack(9, 9, 9, 5, 7, 5, K, K); // seat0 9,5=14 -> +K = 24 bust; seat1 9,7=16; banker 9,5=14 -> +K = 24 bust
  const round = MY.startTableRound({
    deck, table, rng: () => 0,
    seats: [{ isHuman: true, bet: 100 }, { isHuman: true, bet: 100 }, null, null],
    bankerIsHuman: false,
  });
  MY.hitSeat(round, 0, deck);
  assert.equal(round.players[0].busted, true);
  assert.equal(round.players[0].opened, false, 'hidden — a bust is not revealed until opened');
  MY.standSeat(round, 1);
  assert.equal(round.phase, 'banker');

  MY.bankerHit(round, deck);
  assert.equal(malaysianTotal(round.banker.cards).total, 24);
  assert.equal(round.phase, 'settled');
  assert.equal(round.players[0].result, 'push', 'both sides bust');
  assert.equal(round.players[0].payout, 0);
  assert.equal(round.players[1].result, 'win');
  assert.equal(round.players[1].payout, 100);
});

test('malaysian: a banker Five Dragon settles every still-unopened seat, leaving an already-paid special alone', () => {
  const deck = stack(A, 9, 9, Q, 7, 3, 2, 2, 2); // seat0 A,Q = Ban Luck (paid at once); seat1 9,7=16; banker 9,3 -> +2+2+2 = 18, five cards
  const round = MY.startTableRound({
    deck, table, rng: () => 0,
    seats: [{ isHuman: true, bet: 100 }, { isHuman: true, bet: 100 }, null, null],
    bankerIsHuman: false,
  });
  assert.equal(round.players[0].result, 'banluck', 'already paid at the deal');
  MY.standSeat(round, 1);
  assert.equal(round.phase, 'banker');

  MY.bankerHit(round, deck); // 12 -> 14
  MY.bankerHit(round, deck); // 14 -> 16
  MY.bankerHit(round, deck); // 16 -> 18, five cards, a Five Dragon of its own
  assert.equal(round.banker.cards.length, 5);
  assert.equal(malaysianTotal(round.banker.cards).total, 18);
  assert.equal(round.phase, 'settled');
  assert.equal(round.players[1].result, 'lose');
  assert.equal(round.players[1].payout, -200);
  assert.equal(round.players[0].result, 'banluck', "the banker's Five Dragon never touches an already-resolved special");
});

// ---------------------------------------------------------------------------
// Malaysian: empty seats, the bankroll gate, and a bot banker
// ---------------------------------------------------------------------------

test('malaysian: empty seats are skipped by dealing and by seat order', () => {
  const deck = stack(9, 9, 7, 4); // seat1 9,7 = 16; banker 9,4 = 13
  const seats = [null, { isHuman: false, name: 'Bee', bet: 100 }, null, null];
  const round = MY.startTableRound({ deck, table, rng: () => 0, seats, bankerIsHuman: false });
  assert.equal(round.players[0], null);
  assert.equal(round.players[2], null);
  assert.equal(round.players[3], null);
  assert.equal(round.players[1].cards.length, 2);
  assert.equal(MY.nextActionableSeat(round), 1, 'the only filled seat, wherever it sits in the row');
  assert.equal(round.banker.cards.length, 2, 'exactly two cards, not stretched by the empty seats');
});

test('malaysian: the bankroll requirement to bank scales 7x per filled seat', () => {
  assert.equal(MY.bankRequirement(table, 0), 0);
  assert.equal(MY.bankRequirement(table, 1), 7_000);
  assert.equal(MY.bankRequirement(table, 4), 28_000, '4 seats x 7:1 for 777, same ceiling the old fixed 28x table max used');

  assert.equal(MY.canBank(table, 27_999, 4), false);
  assert.equal(MY.canBank(table, 28_000, 4), true);
  assert.equal(MY.canBank(table, 7_000, 1), true);
  assert.equal(MY.canBank(table, 6_999, 1), false);
});

test('malaysian: banking needs at least one filled seat, no matter the bankroll — Deal has nothing to deal', () => {
  assert.equal(MY.canBank(table, 1_000_000, 0), false);
});

test("malaysian: tableRoundNet is the human's own seat as a player, and the whole table's as banker", () => {
  const round = {
    bankerIsHuman: false,
    players: [
      { isHuman: true, payout: 50 },
      { isHuman: false, payout: -30 },
      null,
      { isHuman: false, payout: 10 },
    ],
  };
  assert.equal(MY.tableRoundNet(round), 50, "as a player, only the human's own seat counts, whatever the bots did");
  round.bankerIsHuman = true;
  assert.equal(MY.tableRoundNet(round), -30, 'as banker, every seat\'s payout moves the other way (50 - 30 + 10 = 30, out of the house)');
});

test('malaysian: a bot-banker round (a human seat among bots, one seat left empty) plays to completion', () => {
  const rng = makeRng('table-completion-1');
  const deck = createShoe(1, rng);
  const seats = [
    { isHuman: true, bet: 100 },
    { isHuman: false, name: 'Bee' },
    null, // stays empty throughout — skipped by dealing and by turn order
    { isHuman: false, name: 'Farid' },
  ];
  const round = MY.startTableRound({ deck, table, rng, seats, bankerIsHuman: false });
  assert.equal(round.players[2], null);

  // A simple, always-legal human policy (stand once eligible, otherwise
  // hit) — enough to reach a real settlement without needing to script every
  // branch a human could actually choose.
  let guard = 0;
  while (round.phase !== 'settled') {
    if (++guard > 200) throw new Error('round never settled');
    if (round.phase === 'players') {
      const i = round.activeSeat;
      const p = round.players[i];
      if (p.isHuman) {
        if (MY.canStandSeat(round, i)) MY.standSeat(round, i);
        else MY.hitSeat(round, i, deck);
      } else {
        MY.playSeatTurn(round, i, deck, rng);
      }
    } else if (round.phase === 'banker') {
      const step = MY.bankerBotStep(round, deck, rng);
      if (step.type === 'done') break;
    } else {
      break;
    }
  }

  assert.equal(round.phase, 'settled');
  assert.equal(round.settled, true);
  for (const p of round.players) {
    if (!p) continue;
    assert.equal(p.opened, true, `${p.name ?? 'seat'} was never settled`);
    assert.equal(typeof p.payout, 'number');
  }
  const net = MY.tableRoundNet(round);
  assert.equal(net, round.players[0].payout, "the human isn't banking, so their net is just their own seat's payout");
});

test('malaysian: the bot banker makes the identical sequence of decisions for identical seat card counts, whatever the ranks', () => {
  // Two hand-built "banker phase" rounds per seed, sharing everything
  // bankerBotStep is allowed to read (the banker's own evolving total, and
  // every seat's card count/opened/busted state) and differing only in the
  // one thing it must never read: the seats' own card ranks.
  function buildShape(seed) {
    const rng = makeRng(seed);
    const seats = [0, 1, 2, 3].map((seatIndex) => ({
      seatIndex,
      length: 2 + Math.floor(rng() * 4), // 2..5 cards
      busted: rng() < 0.3,
    }));
    const bankerTotal = 12 + Math.floor(rng() * 8); // 12..19: spans hit / open / chase / stand
    return { seats, bankerTotal };
  }

  function buildRound(shape, rankPool) {
    const players = shape.seats.map(({ seatIndex, length, busted }) => ({
      seatIndex,
      isHuman: false,
      name: `seat${seatIndex}`,
      bet: 100,
      cards: Array.from({ length }, (_, c) => C(rankPool[(seatIndex + c) % rankPool.length])),
      special: null,
      busted,
      stood: false,
      opened: false,
      result: null,
      payout: 0,
      actions: [],
      bankerTotalAtOpen: null,
      runDeclined: false,
      bankerSpecialPending: false,
    }));
    // Two ordinary (non-ace, non-seven) cards summing to the shape's target —
    // shared between both rounds, so the banker's own total path is identical.
    const bankerCards = [C(9), C(shape.bankerTotal - 9)];
    return {
      variant: 'malaysian-table',
      table,
      players,
      banker: { cards: bankerCards, special: null },
      bankerIsHuman: false,
      phase: 'banker',
      settled: false,
      activeSeat: -1,
    };
  }

  let sawHit = false;
  let sawOpen = false;
  for (let seed = 1; seed <= 200; seed++) {
    const shape = buildShape(seed);
    const lowRound = buildRound(shape, [3, 4, 5, 6]);
    const highRound = buildRound(shape, [8, 9, 10, 10]);
    // Enough low, non-seven hit cards for the banker's own turn — at most
    // three hits ever happen (it starts at two cards, five is the ceiling).
    const lowDeck = stack(3, 3, 3, 3, 3, 3, 3, 3);
    const highDeck = stack(3, 3, 3, 3, 3, 3, 3, 3);

    const lowSteps = [];
    const highSteps = [];
    for (let guard = 0; guard < 20; guard++) {
      const a = MY.bankerBotStep(lowRound, lowDeck, () => 0);
      const b = MY.bankerBotStep(highRound, highDeck, () => 0);
      lowSteps.push({ type: a.type, seatIndex: a.seatIndex });
      highSteps.push({ type: b.type, seatIndex: b.seatIndex });
      if (a.type === 'hit') sawHit = true;
      if (a.type === 'open') sawOpen = true;
      if (a.type === 'done') break;
    }
    assert.deepEqual(lowSteps, highSteps, `seed ${seed}: the banker's decisions differed between a low-rank and a high-rank seat layout`);
  }
  assert.ok(sawHit && sawOpen, 'expected both a hit and an opening to occur across 200 seeds');
});
