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
// Malaysian: Ban Ban, Ban Luck, dealer specials, ties
// ---------------------------------------------------------------------------

test('malaysian: Ban Ban (two aces) pays 3:1', () => {
  const deck = stack(A, 3, A, 4);
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(round.player.special, 'banban');
  assert.equal(round.phase, 'settled');
  assert.equal(round.player.result, 'banban');
  assert.equal(round.player.payout, 300);
});

test('malaysian: Ban Luck (ace + ten-value) pays 2:1', () => {
  const deck = stack(A, 3, Q, 4);
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(round.player.special, 'banluck');
  assert.equal(round.player.payout, 200);
});

test('malaysian: a dealer special ends the round at once and beats a plain hand', () => {
  const deck = stack(9, A, 5, Q); // player 9,5 no special; dealer A,Q = Ban Luck
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(round.phase, 'settled');
  assert.equal(round.dealer.special, 'banluck');
  assert.equal(round.player.result, 'lose');
  assert.equal(round.player.payout, -200);
});

test('malaysian: Ban Ban beats a dealer Ban Luck, and equal specials push', () => {
  const winDeck = stack(A, A, A, K); // player Ban Ban, dealer Ban Luck
  const win = MY.startRound({ deck: winDeck, bet: 100 });
  assert.equal(win.player.result, 'banban');
  assert.equal(win.player.payout, 300);

  const pushDeck = stack(A, A, K, Q); // both Ban Luck
  const push = MY.startRound({ deck: pushDeck, bet: 100 });
  assert.equal(push.player.result, 'push');
  assert.equal(push.player.payout, 0);
});

test('malaysian: 777 pays 7:1', () => {
  const deck = stack(7, 2, 7, 3, 7);
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(round.phase, 'player');
  MY.hit(round, deck);
  assert.equal(round.player.result, '777');
  assert.equal(round.player.payout, 700);
});

test('malaysian: Five Dragon wins at once, 2:1 normally and 3:1 on exactly 21', () => {
  const lowDeck = stack(TWO, 9, TWO, 9, TWO, TWO, TWO); // five 2s = 10
  const low = MY.startRound({ deck: lowDeck, bet: 100 });
  MY.hit(low, lowDeck); MY.hit(low, lowDeck); MY.hit(low, lowDeck);
  assert.equal(low.player.result, 'five-dragon');
  assert.equal(low.player.payout, 200);

  const twentyOneDeck = stack(3, 9, 4, 9, 5, 6, 3); // 3+4+5+6+3 = 21
  const twentyOne = MY.startRound({ deck: twentyOneDeck, bet: 100 });
  MY.hit(twentyOne, twentyOneDeck); MY.hit(twentyOne, twentyOneDeck); MY.hit(twentyOne, twentyOneDeck);
  assert.equal(twentyOne.player.result, 'five-dragon');
  assert.equal(twentyOne.player.payout, 300);
});

test('malaysian: stand is disabled below 16', () => {
  const deck = stack(9, 5, 5, 5, 5); // player 9,5 = 14
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(MY.canStand(round), false);
  MY.hit(round, deck); // +5 = 19
  assert.equal(MY.canStand(round), true);
});

test('malaysian: a player bust loses outright, before the dealer ever plays', () => {
  const deck = stack(K, 2, Q, 2, K); // player K,Q then hits a K = 30, bust
  const round = MY.startRound({ deck, bet: 100 });
  MY.hit(round, deck);
  assert.equal(round.player.busted, true);
  assert.equal(round.player.result, 'bust');
  assert.equal(round.player.payout, -100);
  assert.equal(round.phase, 'settled', 'the round is over without the dealer drawing a single card');
  assert.equal(round.dealer.cards.length, 2, 'the dealer never gets to play, let alone bust');
});

test('malaysian: dealer draws below 16 and stands from 16', () => {
  const deck = stack(9, 5, 7, 4, 3, 5); // player 9,7=16 stands; dealer 5,4=9 draws until >=16
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(MY.canStand(round), true);
  MY.stand(round);
  assert.equal(round.phase, 'dealer');
  MY.playDealer(round, deck);
  assert.deepEqual(round.dealer.cards.map((c) => c.rank), [5, 4, 3, 5]);
  assert.equal(malaysianTotal(round.dealer.cards).total, 17, 'stopped the instant it reached 16 or more');
  assert.equal(round.player.result, 'lose');
});

test('malaysian: a dealer five-card 21-or-under beats a non-special player at 2:1', () => {
  const deck = stack(9, TWO, 7, TWO, TWO, TWO, TWO); // player 9,7=16 stands; dealer draws five 2s
  const round = MY.startRound({ deck, bet: 100 });
  MY.stand(round);
  MY.playDealer(round, deck);
  assert.equal(round.dealer.cards.length, 5);
  assert.equal(round.player.result, 'lose');
  assert.equal(round.player.payout, -200, '2:1 against the player, even though 16 would beat a plain 10');
});

// ---------------------------------------------------------------------------
// Malaysian: Run (player seat)
// ---------------------------------------------------------------------------

test('malaysian: Run on an opening 15 pushes at once, including ace-high A+4', () => {
  const deck = stack(9, 5, 6, 4); // player 9,6 = 15
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(MY.canRun(round), true);
  MY.run(round);
  assert.equal(round.player.result, 'run');
  assert.equal(round.player.payout, 0);
  assert.equal(round.phase, 'settled');
  assert.equal(round.dealer.cards.length, 2, 'the dealer never plays this hand out');

  const aceDeck = stack(A, 5, 4, 4); // player A,4 = 15, ace counted high (11) on two cards
  const aceRound = MY.startRound({ deck: aceDeck, bet: 100 });
  assert.equal(malaysianTotal(aceRound.player.cards).total, 15);
  assert.equal(MY.canRun(aceRound), true);
  MY.run(aceRound);
  assert.equal(aceRound.player.payout, 0);
});

test('malaysian: Run is not offered at 14, at 16, or once a card has been hit', () => {
  const at14 = MY.startRound({ deck: stack(9, 5, 5, 4), bet: 100 }); // 9,5 = 14
  assert.equal(MY.canRun(at14), false);

  const at16 = MY.startRound({ deck: stack(9, 5, 7, 4), bet: 100 }); // 9,7 = 16
  assert.equal(MY.canRun(at16), false);

  const deck = stack(6, 5, 9, 4, 2); // player 6,9 = 15; hit draws a 2 -> 17
  const afterHit = MY.startRound({ deck, bet: 100 });
  assert.equal(MY.canRun(afterHit), true);
  MY.hit(afterHit, deck);
  assert.equal(MY.canRun(afterHit), false, 'run is only offered on the opening two cards');
});

test('malaysian: Run beats the dealer\'s special — running on 15 pushes even against Ban Luck', () => {
  const deck = stack(9, A, 6, Q); // player 9,6 = 15; dealer A,Q = Ban Luck
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(round.dealer.special, 'banluck');
  assert.equal(round.phase, 'player', 'the dealer\'s special is held back while run is still on offer');
  assert.equal(round.dealerSpecialPending, true);
  assert.equal(MY.canRun(round), true);
  MY.run(round);
  assert.equal(round.player.result, 'run');
  assert.equal(round.player.payout, 0, 'a push regardless of the dealer\'s special');
  assert.equal(round.phase, 'settled');
});

test('malaysian: declining Run on 15 lets the dealer\'s Ban Luck resolve the round at once, for -2x', () => {
  const deck = stack(9, A, 6, Q, 2); // same opening; the extra card must go unused
  const round = MY.startRound({ deck, bet: 100 });
  assert.equal(MY.canRun(round), true);
  MY.hit(round, deck); // declines the run
  assert.equal(round.player.result, 'lose');
  assert.equal(round.player.payout, -200, '2:1 against the player, the dealer\'s Ban Luck multiple');
  assert.equal(round.phase, 'settled');
  assert.equal(round.player.cards.length, 2, 'the dealer\'s special pre-empted the hit — no card was drawn');
});

// ---------------------------------------------------------------------------
// Malaysian dealer seat: the human deals against four bots
// ---------------------------------------------------------------------------

const dealerSeatTable = { min: 100, max: 1000 };
const betRng = () => 0; // every randomBotBet() call lands on table.min, deterministically

test('malaysian dealer seat: a bot special is paid at the deal', () => {
  const deck = stack(A, 9, 9, 9, 9, Q, 3, 4, 5, 3); // bot0 = A,Q = Ban Luck; the rest plain
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  assert.equal(round.bots[0].special, 'banluck');
  assert.equal(round.bots[0].opened, true);
  assert.equal(round.bots[0].result, 'banluck');
  assert.equal(round.bots[0].payout, round.bots[0].bet * 2);
  assert.equal(round.bots[1].opened, false, 'a plain hand is untouched, waiting for its turn');
});

test('malaysian dealer seat: a dealer special ends the round, settling every bot against it', () => {
  // bot0 = A,A = Ban Ban (equal to the dealer's, so it pushes); bot1 = A,K = Ban
  // Luck (ranks below Ban Ban, so it loses at the dealer's 3:1); bot2/bot3 plain.
  const deck = stack(A, A, 9, 9, A, A, K, 3, 4, A);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  assert.equal(round.dealer.special, 'banban');
  assert.equal(round.phase, 'settled');
  assert.equal(round.bots[0].result, 'push', 'an equal-or-better special pushes');
  assert.equal(round.bots[0].payout, 0);
  assert.equal(round.bots[1].result, 'lose');
  assert.equal(round.bots[1].payout, -round.bots[1].bet * 3);
  assert.equal(round.bots[2].result, 'lose');
  assert.equal(round.bots[2].payout, -round.bots[2].bet * 3);
  assert.equal(round.bots[3].result, 'lose');
  assert.equal(round.bots[3].payout, -round.bots[3].bet * 3);
});

test('malaysian dealer seat: a bot on an opening 15 decides Run before the dealer\'s special is applied', () => {
  // bot0 = 9,6 = 15 (rng()=0 always wins the flat 50% run chance); bot1 =
  // A,K = Ban Luck (loses to the dealer's Ban Ban, ranked below it); bot2/3 plain.
  const deck = stack(9, A, 9, 9, A, 6, K, 3, 4, A);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: () => 0 });
  assert.equal(round.dealer.special, 'banban');
  assert.equal(round.bots[0].result, 'run', 'decided before the dealer\'s Ban Ban was ever applied');
  assert.equal(round.bots[0].payout, 0);
  assert.equal(round.bots[1].result, 'lose');
  assert.equal(round.bots[1].payout, -round.bots[1].bet * 3);
  assert.equal(round.phase, 'settled');
});

test('malaysian dealer seat: a bot\'s Run decision never depends on the dealer\'s hidden cards', () => {
  // Same bot cards (bot0 opens at 15, bots 1-3 at 16 so they never touch
  // wantsToRun), same seed, two decks that differ only in the dealer's own
  // two cards — one a weak 12, one a strong 20, neither a special. If a bot
  // decision ever reads round.dealer.cards, these two would diverge; they
  // must not, across every seed, because the dealer's hand is face down to
  // every bot until the human dealer opens it.
  const buildDeck = (dealerRanks) => stack(9, 9, 9, 9, dealerRanks[0], 6, 7, 7, 7, dealerRanks[1]);
  let sawRun = false;
  let sawDecline = false;
  for (let seed = 1; seed <= 200; seed++) {
    const weakRound = MY.startDealerSeatRound({
      deck: buildDeck([9, 3]), table: dealerSeatTable, rng: makeRng(seed),
    });
    const strongRound = MY.startDealerSeatRound({
      deck: buildDeck([10, 10]), table: dealerSeatTable, rng: makeRng(seed),
    });
    assert.equal(malaysianTotal(weakRound.dealer.cards).total, 12);
    assert.equal(malaysianTotal(strongRound.dealer.cards).total, 20);
    assert.equal(weakRound.dealer.special, null);
    assert.equal(strongRound.dealer.special, null);

    const weakRan = weakRound.bots[0].result === 'run';
    const strongRan = strongRound.bots[0].result === 'run';
    assert.equal(weakRan, strongRan, `seed ${seed}: run decision differed between a weak and a strong dealer hand`);
    // Compare the decision's own outcome, not the two decks' card ids (each
    // buildDeck() call mints fresh card objects from the module's shared
    // uid counter, so ids never match between the weak and strong round —
    // that is deck bookkeeping, not part of the bot's decision).
    const snapshot = (bot) => ({
      bet: bot.bet,
      ranks: bot.cards.map((c) => c.rank),
      busted: bot.busted,
      stood: bot.stood,
      opened: bot.opened,
      result: bot.result,
      payout: bot.payout,
      actions: bot.actions,
      runDeclined: bot.runDeclined,
    });
    assert.deepEqual(snapshot(weakRound.bots[0]), snapshot(strongRound.bots[0]), `seed ${seed}: bot0 state differed`);
    if (weakRan) sawRun = true; else sawDecline = true;
  }
  // A flat 50% chance across 200 seeds should hit both outcomes — otherwise
  // this test could pass by accident (e.g. if both sides always ran).
  assert.ok(sawRun && sawDecline, 'expected both run and decline to occur across 200 seeds');
});

test('malaysian dealer seat: a bot\'s own Five Dragon pays out immediately, mid-turn', () => {
  const deck = stack(TWO, 9, 9, 9, 9, TWO, 3, 4, 5, 3, TWO, TWO, TWO); // bot0 draws five 2s
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  MY.playBotTurn(round, 0, deck, () => 0.5); // total stays under 16 throughout, so rng never matters
  assert.equal(round.bots[0].cards.length, 5);
  assert.equal(round.bots[0].result, 'five-dragon');
  assert.equal(round.bots[0].payout, round.bots[0].bet * 2);
  assert.equal(round.bots[0].opened, true);
});

test('malaysian dealer seat: nothing can be opened below 16', () => {
  // bot0..3 = 9+2/3/4/5 = 11/12/13/14, each needing a hit; dealer = 9,3 = 12
  const deck = stack(9, 9, 9, 9, 9, 2, 3, 4, 5, 3, 5, 5, 5, 5);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  const stubRng = () => 0.99; // 0.99 never wins a run or a Five Dragon chase
  while (round.phase === 'bots') {
    const idx = round.bots.findIndex((b) => !b.opened && !b.busted && !b.stood);
    MY.playBotTurn(round, idx, deck, stubRng);
  }
  assert.equal(round.phase, 'dealer');
  assert.ok(malaysianTotal(round.dealer.cards).total < 16);
  for (let i = 0; i < 4; i++) {
    assert.equal(MY.canOpenBot(round, i), false);
    assert.equal(MY.openBot(round, i).ok, false);
  }
});

test("malaysian dealer seat: opening compares against the dealer's total at that moment, and a later draw only changes later openings", () => {
  const deck = stack(9, 9, 9, 9, 9, 9, 5, 7, 7, 7, 5, 3);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  const stubRng = () => 0.99;
  MY.playBotTurn(round, 0, deck, stubRng); // 9,9 = 18, stands immediately
  MY.playBotTurn(round, 1, deck, stubRng); // 9,5 = 14 -> forced hit -> 19, stands
  MY.playBotTurn(round, 2, deck, stubRng); // 9,7 = 16, stands
  MY.playBotTurn(round, 3, deck, stubRng); // 9,7 = 16, stands
  assert.equal(round.phase, 'dealer');
  assert.equal(malaysianTotal(round.dealer.cards).total, 16);

  assert.equal(MY.canOpenBot(round, 0), true);
  MY.openBot(round, 0); // 18 vs the dealer's 16 -> bot0 wins
  assert.equal(round.bots[0].result, 'win');
  assert.equal(round.bots[0].dealerTotalAtOpen, 16);

  MY.dealerHit(round, deck); // 16 -> 19
  assert.equal(malaysianTotal(round.dealer.cards).total, 19);
  assert.equal(round.bots[0].result, 'win', "bot0's already-settled result is untouched by the later draw");
  assert.equal(round.bots[0].payout, round.bots[0].bet);

  MY.openBot(round, 1); // bot1's 19 vs the dealer's NEW total, 19 -> push
  assert.equal(round.bots[1].dealerTotalAtOpen, 19);
  assert.equal(round.bots[1].result, 'push');
  assert.equal(round.bots[1].payout, 0);
});

test('malaysian dealer seat: a dealer bust pushes only the bots that busted themselves', () => {
  const deck = stack(9, 9, 9, 9, 9, 5, 7, 7, 7, 3, K, K);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  const stubRng = () => 0.99;
  MY.playBotTurn(round, 0, deck, stubRng); // 9,5 = 14 -> forced hit -> a King busts it at 24
  assert.equal(round.bots[0].busted, true);
  assert.equal(round.bots[0].opened, false, 'hidden — a bust is not revealed until opened');
  MY.playBotTurn(round, 1, deck, stubRng); // 16, stands
  MY.playBotTurn(round, 2, deck, stubRng); // 16, stands
  MY.playBotTurn(round, 3, deck, stubRng); // 16, stands
  assert.equal(round.phase, 'dealer');

  MY.dealerHit(round, deck); // 12 -> 22, bust
  assert.equal(malaysianTotal(round.dealer.cards).total, 22);
  assert.equal(round.phase, 'settled');
  assert.equal(round.bots[0].result, 'push', 'both sides bust');
  assert.equal(round.bots[0].payout, 0);
  assert.equal(round.bots[1].result, 'win');
  assert.equal(round.bots[1].payout, round.bots[1].bet);
  assert.equal(round.bots[2].result, 'win');
  assert.equal(round.bots[3].result, 'win');
});

test('malaysian dealer seat: a dealer Five Dragon settles every still-unopened bot, leaving an already-paid special alone', () => {
  const deck = stack(A, 9, 9, 9, 9, Q, 7, 7, 7, 3, TWO, TWO, TWO);
  const round = MY.startDealerSeatRound({ deck, table: dealerSeatTable, rng: betRng });
  assert.equal(round.bots[0].result, 'banluck', 'already paid at the deal');
  const stubRng = () => 0.99;
  MY.playBotTurn(round, 1, deck, stubRng); // 16, stands
  MY.playBotTurn(round, 2, deck, stubRng); // 16, stands
  MY.playBotTurn(round, 3, deck, stubRng); // 16, stands
  assert.equal(round.phase, 'dealer');

  MY.dealerHit(round, deck); // 12 -> 14
  MY.dealerHit(round, deck); // 14 -> 16
  MY.dealerHit(round, deck); // 16 -> 18, five cards, Five Dragon
  assert.equal(round.dealer.cards.length, 5);
  assert.equal(malaysianTotal(round.dealer.cards).total, 18);
  assert.equal(round.phase, 'settled');
  for (const i of [1, 2, 3]) {
    assert.equal(round.bots[i].opened, true);
    assert.equal(round.bots[i].result, 'lose');
    assert.equal(round.bots[i].payout, -round.bots[i].bet * 2);
  }
  assert.equal(round.bots[0].result, 'banluck', "the dealer's Five Dragon never touches an already-resolved special");
});

test('malaysian dealer seat: the bankroll gate is 28x the table max (4 bots x 7:1 for 777)', () => {
  assert.equal(MY.dealerSeatBankrollRequirement(dealerSeatTable), 28_000);
  assert.equal(MY.canPlayDealerSeat(dealerSeatTable, 27_999), false);
  assert.equal(MY.canPlayDealerSeat(dealerSeatTable, 28_000), true);
});
