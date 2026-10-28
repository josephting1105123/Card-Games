import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardFromId } from '../src/core/cards.js';
import { makeRng, randInt } from '../src/core/rng.js';
import {
  Category, bestHand, categoryName, compareHands, describeHand, evaluate5, parseCards, pokerRank,
} from '../src/games/holdem/rules.js';
import {
  Phase, act, buildPots, createHand, legalActions, nextButton, seatView, totalChips,
} from '../src/games/holdem/engine.js';

const best = (text) => bestHand(parseCards(text));

// ---- rules -----------------------------------------------------------------

test('every category is recognised from five cards and from seven', () => {
  const cases = [
    ['Ks Qh Jc 9d 7s', 'Ks Qh Jc 9d 7s 5h 3d', Category.HIGH_CARD, 'High card, king'],
    ['Js Jh Kc 9d 7s', 'Js Jh Kc 9d 7s 5h 2d', Category.PAIR, 'Pair of jacks'],
    ['As Ah 4c 4d 9s', 'As Ah 4c 4d 9s 2h 7d', Category.TWO_PAIR, 'Two pair, aces and fours'],
    ['8s 8h 8c Kd Qs', '8s 8h 8c Kd Qs 5h 9d', Category.TRIPS, 'Three of a kind, eights'],
    ['9s 8h 7c 6d 5s', '9s 8h 7c 6d 5s Kh 2d', Category.STRAIGHT, 'Straight, nine high'],
    ['As 9s 7s 4s 2s', 'As 9s 7s 4s 2s Kh Kd', Category.FLUSH, 'Flush, ace high'],
    ['Ks Kh Kc 7d 7s', 'Ks Kh Kc 7d 7s 2h 3d', Category.FULL_HOUSE, 'Full house, kings over sevens'],
    ['Qs Qh Qc Qd Ks', 'Qs Qh Qc Qd Ks 3h 9d', Category.QUADS, 'Four of a kind, queens'],
    ['9h 8h 7h 6h 5h', '9h 8h 7h 6h 5h As Kd', Category.STRAIGHT_FLUSH, 'Straight flush, nine high'],
  ];
  for (const [five, seven, category, name] of cases) {
    const a = best(five);
    const b = best(seven);
    assert.equal(a.category, category, five);
    assert.equal(b.category, category, seven);
    assert.equal(a.name, name);
    assert.equal(b.name, name);
    assert.equal(a.score, b.score, 'extra cards that do not help leave the score alone');
  }
});

test('royal flush has its own name and category and names are stable', () => {
  const royal = best('As Ks Qs Js Ts');
  assert.equal(royal.name, 'Royal flush');
  assert.equal(royal.category, Category.STRAIGHT_FLUSH);
  assert.equal(describeHand(evaluate5(parseCards('2s 2h 5c 9d Ks'))), 'Pair of twos');
  assert.equal(categoryName(Category.TRIPS), 'Three of a kind');
  assert.equal(categoryName(Category.STRAIGHT_FLUSH), 'Straight flush');
});

test('category order: straight flush > quads > full house > flush > straight', () => {
  const hands = [
    best('9h 8h 7h 6h 5h'), best('Qs Qh Qc Qd 2s'), best('Ks Kh Kc 7d 7s'),
    best('As 9s 7s 4s 2s'), best('9s 8h 7c 6d 5s'), best('8s 8h 8c Kd 2s'),
    best('As Ah 4c 4d 9s'), best('Js Jh 9c 5d 2s'), best('Ks 9h 7c 5d 2s'),
  ];
  for (let i = 0; i + 1 < hands.length; i++) {
    assert.equal(compareHands(hands[i], hands[i + 1]), 1, `${hands[i].name} beats ${hands[i + 1].name}`);
    assert.equal(compareHands(hands[i + 1], hands[i]), -1);
  }
});

test('kickers decide between equal categories', () => {
  assert.equal(compareHands(best('As Ah Kc 7d 3s'), best('Ac Ad Qs 7h 3d')), 1);
  assert.equal(compareHands(best('Ks Kh 7c 7d As'), best('Kc Kd 7s 7h Qs')), 1);
  // The fifth card is the only difference: J 9 vs J 8 after A K Q.
  assert.equal(compareHands(best('As Kh Qc Jd 9s'), best('Ac Kd Qh Js 8d')), 1);
  assert.equal(compareHands(best('Ks Kh Kc 2d 2s'), best('Qs Qh Qc Ad As')), 1);
});

test('the wheel is a five-high straight that loses to a six-high straight', () => {
  const wheel = best('As 2h 3c 4d 5s');
  assert.equal(wheel.category, Category.STRAIGHT);
  assert.deepEqual(wheel.ranks, [5]);
  assert.equal(wheel.name, 'Straight, five high');
  assert.deepEqual(wheel.cards.map(pokerRank), [5, 4, 3, 2, 14]);
  assert.equal(compareHands(best('2s 3h 4c 5d 6s'), wheel), 1);
  const steel = best('Ah 2h 3h 4h 5h');
  assert.equal(steel.category, Category.STRAIGHT_FLUSH);
  assert.equal(steel.name, 'Straight flush, five high');
  assert.equal(compareHands(steel, best('Qs Qh Qc Qd 2s')), 1);
});

test('broadway beats a king-high straight and the straight does not wrap', () => {
  assert.equal(compareHands(best('As Kd Qc Jh Ts'), best('Kc Qd Jh Ts 9s')), 1);
  const wrap = best('Qs Kh As 2d 3c');
  assert.equal(wrap.category, Category.HIGH_CARD);
  assert.equal(wrap.name, 'High card, ace');
});

test('five-card ordering puts the made part first', () => {
  const hand = evaluate5(parseCards('2s Ah 7c Ad 3s'));
  assert.deepEqual(hand.cards.map(pokerRank), [14, 14, 7, 3, 2]);
  assert.deepEqual(hand.ranks, [14, 7, 3, 2]);
});

test('ties: the board playing, and the same ranks in other suits', () => {
  const board = 'Ts Js Qs Ks As';
  const a = best(`${board} 2c 3d`);
  const b = best(`${board} 4h 5c`);
  assert.equal(a.score, b.score);
  assert.equal(compareHands(a, b), 0);
  assert.equal(best('As Kh Qd 7c 3s').score, best('Ah Ks Qc 7d 3h').score);
});

test('seven cards: flush beats a straight that is also present', () => {
  const hand = best('9s 8s 7s 2s 4s Th 6h');
  assert.equal(hand.category, Category.FLUSH);
  assert.equal(hand.name, 'Flush, nine high');
});

test('seven cards: two trips make a full house on the higher trips; three pair keep the top two', () => {
  assert.equal(best('Ks Kh Kc 7d 7s 7h 2c').name, 'Full house, kings over sevens');
  const threePair = best('As Ah Kc Kd 9s 9h 2c');
  assert.equal(threePair.name, 'Two pair, aces and kings');
  assert.deepEqual(threePair.ranks, [14, 13, 9]);
});

test('a flush uses its top five cards of six or seven suited', () => {
  const seven = best('As Ks 9s 7s 4s 3s 2s');
  assert.equal(seven.category, Category.FLUSH);
  assert.deepEqual(seven.ranks, [14, 13, 9, 7, 4]);
  const six = best('Qd Jd 8d 5d 3d 2d Ac');
  assert.deepEqual(six.ranks, [12, 11, 8, 5, 3]);
});

test('a straight is found among seven cards that include a pair', () => {
  const hand = best('9s 9h 8c 7d 6s 5h 2c');
  assert.equal(hand.category, Category.STRAIGHT);
  assert.equal(hand.name, 'Straight, nine high');
});

test('parseCards reads the deuce as the deck stores it and rejects junk', () => {
  const [two] = parseCards('2s');
  assert.equal(two.rank, 15);
  assert.equal(pokerRank(two), 2);
  assert.throws(() => parseCards('Zs'));
  assert.throws(() => parseCards('10s'));
  assert.throws(() => parseCards('Ax'));
});

// ---- buildPots -------------------------------------------------------------

test('buildPots: one short stack makes a main pot and a side pot', () => {
  assert.deepEqual(buildPots([100, 300, 300], [false, false, false]), [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
  ]);
});

test('buildPots: a folded contributor feeds pots but is never eligible', () => {
  assert.deepEqual(buildPots([100, 50, 300, 300], [false, true, false, false]), [
    { amount: 350, eligible: [0, 2, 3] },
    { amount: 400, eligible: [2, 3] },
  ]);
});

test('buildPots: chips folded above the top live level go to the last pot', () => {
  assert.deepEqual(buildPots([100, 400, 100], [false, true, false]), [
    { amount: 600, eligible: [0, 2] },
  ]);
});

test('buildPots: four different all-in levels give four pots', () => {
  assert.deepEqual(buildPots([50, 100, 200, 400], [false, false, false, false]), [
    { amount: 200, eligible: [0, 1, 2, 3] },
    { amount: 150, eligible: [1, 2, 3] },
    { amount: 200, eligible: [2, 3] },
    { amount: 200, eligible: [3] },
  ]);
});

test('buildPots: equal contributions collapse into one pot and empty input gives none', () => {
  assert.deepEqual(buildPots([200, 200, 200], [false, false, false]), [{ amount: 600, eligible: [0, 1, 2] }]);
  assert.deepEqual(buildPots([0, 0, 0], [false, false, false]), []);
});

// ---- engine ----------------------------------------------------------------

const BURN = cardFromId(0);

function newHand(stacks, options = {}) {
  return createHand({
    seed: options.seed ?? 'holdem-test',
    players: stacks.map((stack, i) => ({ name: `P${i}`, stack })),
    button: options.button ?? 0,
    smallBlind: options.smallBlind ?? 5,
    bigBlind: options.bigBlind ?? 10,
  });
}

/** Overwrite the deal: holes is { seat: 'As Ah' }, board is five cards. */
function rig(state, holes, board) {
  for (const [seat, text] of Object.entries(holes)) state.players[seat].hole = parseCards(text);
  const [f1, f2, f3, t, r] = parseCards(board);
  state.deck = [BURN, f1, f2, f3, BURN, t, BURN, r];
}

function ok(result) {
  assert.equal(result.ok, true, result.error);
  return result;
}

/** Everyone calls or checks until the hand ends. */
function checkdown(state) {
  let guard = 0;
  while (state.turn !== -1) {
    assert.ok(guard++ < 200, 'hand did not end');
    const legal = legalActions(state, state.turn);
    ok(act(state, state.turn, { type: legal.canCheck ? 'check' : 'call' }));
  }
}

test('blinds and first actor: six-handed', () => {
  const s = newHand([1000, 1000, 1000, 1000, 1000, 1000], { button: 0 });
  assert.equal(s.sbSeat, 1);
  assert.equal(s.bbSeat, 2);
  assert.equal(s.turn, 3);
  assert.equal(s.players[1].bet, 5);
  assert.equal(s.players[2].bet, 10);
  assert.equal(s.players[1].stack, 995);
  assert.equal(s.currentBet, 10);
  assert.ok(s.players.every((p) => p.hole.length === 2));
  assert.equal(s.deck.length, 52 - 12);
  assert.equal(totalChips(s), 6000);
});

test('blinds and first actor: heads-up has the button post the small blind and act first', () => {
  const s = newHand([1000, 1000], { button: 1 });
  assert.equal(s.sbSeat, 1);
  assert.equal(s.bbSeat, 0);
  assert.equal(s.turn, 1);
  const legal = legalActions(s, 1);
  assert.equal(legal.toCall, 5);
  // Postflop the big blind (non-button) acts first.
  ok(act(s, 1, { type: 'call' }));
  ok(act(s, 0, { type: 'check' }));
  assert.equal(s.phase, Phase.FLOP);
  assert.equal(s.turn, 0);
});

test('the deal is deterministic and sitting-out seats get nothing', () => {
  const a = newHand([1000, 0, 1000, 1000], { button: 0, seed: 7 });
  const b = newHand([1000, 0, 1000, 1000], { button: 0, seed: 7 });
  assert.deepEqual(a, b);
  assert.equal(a.players[1].sittingOut, true);
  assert.deepEqual(a.players[1].hole, []);
  assert.equal(a.sbSeat, 2);
  assert.equal(a.bbSeat, 3);
  assert.equal(a.turn, 0);
  assert.doesNotThrow(() => structuredClone(a));
});

test('createHand rejects bad tables and buttons; nextButton skips empty seats', () => {
  const players = (stacks) => stacks.map((stack, i) => ({ name: `P${i}`, stack }));
  assert.throws(() => createHand({ seed: 1, players: players([100]), button: 0, smallBlind: 1, bigBlind: 2 }));
  assert.throws(() => createHand({ seed: 1, players: players([100, 0]), button: 0, smallBlind: 1, bigBlind: 2 }));
  assert.throws(() => createHand({ seed: 1, players: players([100, 100, 0]), button: 2, smallBlind: 1, bigBlind: 2 }));
  assert.equal(nextButton(players([0, 50, 0, 70]), -1), 1);
  assert.equal(nextButton(players([0, 50, 0, 70]), 1), 3);
  assert.equal(nextButton(players([0, 50, 0, 70]), 3), 1);
});

test('a hand where everyone limps and checks reaches a showdown with five board cards', () => {
  const s = newHand([1000, 1000, 1000]);
  checkdown(s);
  assert.equal(s.phase, Phase.FINISHED);
  assert.equal(s.board.length, 5);
  assert.equal(s.result.showdown, true);
  assert.equal(s.result.uncontested, false);
  assert.equal(s.result.net.reduce((a, b) => a + b, 0), 0);
  assert.equal(totalChips(s), 3000);
});

test('fold-to-winner is uncontested and hides every other hole card', () => {
  const s = newHand([1000, 1000, 1000]);
  ok(act(s, 0, { type: 'fold' }));
  const r = ok(act(s, 1, { type: 'fold' }));
  assert.equal(r.handEnded, true);
  assert.equal(s.phase, Phase.FINISHED);
  assert.equal(s.result.uncontested, true);
  assert.deepEqual(s.result.shown, []);
  assert.deepEqual(s.result.pots[0].winners, [2]);
  assert.deepEqual(s.result.net, [0, -5, 5]);
  assert.equal(s.board.length, 0);
  for (const viewer of [0, 1, 2]) {
    const view = seatView(s, viewer);
    assert.equal('deck' in view, false);
    for (const p of view.players) {
      if (p.seat === viewer) assert.equal(p.hole.length, 2);
      else assert.equal(p.hole, null);
      assert.equal(p.cardCount, 2);
    }
  }
});

test('acting out of turn or after the hand is over is refused', () => {
  const s = newHand([1000, 1000, 1000]);
  assert.deepEqual(act(s, 1, { type: 'fold' }), { ok: false, error: 'not your turn' });
  assert.equal(legalActions(s, 1), null);
  ok(act(s, 0, { type: 'fold' }));
  ok(act(s, 1, { type: 'fold' }));
  assert.deepEqual(act(s, 2, { type: 'check' }), { ok: false, error: 'hand is over' });
});

test('check and call are refused when they make no sense', () => {
  const s = newHand([1000, 1000, 1000]);
  assert.equal(act(s, 0, { type: 'check' }).error, 'cannot check facing a bet');
  ok(act(s, 0, { type: 'call' }));
  ok(act(s, 1, { type: 'call' }));
  // The big blind has the option and nothing to call.
  assert.equal(act(s, 2, { type: 'call' }).error, 'nothing to call');
  ok(act(s, 2, { type: 'check' }));
  assert.equal(s.phase, Phase.FLOP);
});

test('the minimum raise is enforced and grows with each full raise', () => {
  const s = newHand([1000, 1000, 1000]);
  assert.equal(legalActions(s, 0).minRaiseTo, 20);
  assert.equal(act(s, 0, { type: 'raise', amount: 15 }).error, 'raise below the minimum');
  assert.equal(act(s, 0, { type: 'raise', amount: 5000 }).error, 'not enough chips');
  ok(act(s, 0, { type: 'raise', amount: 20 }));
  assert.equal(legalActions(s, 1).minRaiseTo, 30);
  assert.equal(act(s, 1, { type: 'raise', amount: 25 }).error, 'raise below the minimum');
  ok(act(s, 1, { type: 'raise', amount: 50 }));
  // The raise was by 30, so the next one must be to at least 80.
  assert.equal(legalActions(s, 2).minRaiseTo, 80);
  assert.equal(s.minRaise, 30);
  assert.equal(s.currentBet, 50);
});

test('a bet is a raise from zero and the minimum bet is the big blind', () => {
  const s = newHand([1000, 1000]);
  ok(act(s, 0, { type: 'call' }));
  ok(act(s, 1, { type: 'check' }));
  const legal = legalActions(s, 1);
  assert.equal(legal.isBet, true);
  assert.equal(legal.minRaiseTo, 10);
  assert.equal(act(s, 1, { type: 'bet', amount: 6 }).error, 'raise below the minimum');
  ok(act(s, 1, { type: 'bet', amount: 30 }));
  assert.equal(s.log.at(-1).action, 'bet');
  assert.equal(legalActions(s, 0).minRaiseTo, 60);
});

test('a short all-in does not reopen raising for a player who already acted', () => {
  const s = newHand([1000, 1000, 130]);
  ok(act(s, 0, { type: 'raise', amount: 100 })); // full raise, level 100
  ok(act(s, 1, { type: 'call' }));
  ok(act(s, 2, { type: 'allin' })); // 130 total: a raise of 30, short of the 90 minimum
  assert.equal(s.currentBet, 130);
  assert.equal(s.minRaise, 90);
  const legal = legalActions(s, 0);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.canCall, true);
  assert.equal(legal.toCall, 30);
  assert.equal(act(s, 0, { type: 'raise', amount: 400 }).error, 'betting is closed to you');
  // 'allin' for a closed player is just the call.
  ok(act(s, 0, { type: 'allin' }));
  assert.equal(s.players[0].bet, 130);
  assert.equal(s.players[0].allIn, false);
  const r = ok(act(s, 1, { type: 'call' }));
  assert.equal(r.streetEnded, true);
  assert.equal(s.phase, Phase.FLOP);
  assert.equal(s.turn, 1);
});

test('a full all-in raise does reopen raising', () => {
  const s = newHand([1000, 1000, 400]);
  ok(act(s, 0, { type: 'raise', amount: 100 }));
  ok(act(s, 1, { type: 'call' }));
  ok(act(s, 2, { type: 'allin' })); // to 400: a raise of 300
  assert.equal(legalActions(s, 0).canRaise, true);
  assert.equal(s.minRaise, 300);
  assert.equal(legalActions(s, 0).minRaiseTo, 700);
});

test('several short all-ins that add up to a full raise reopen the betting', () => {
  const s = newHand([1000, 1000, 160, 220]);
  ok(act(s, 3, { type: 'call' }));
  ok(act(s, 0, { type: 'call' }));
  ok(act(s, 1, { type: 'call' }));
  ok(act(s, 2, { type: 'check' }));
  assert.equal(s.phase, Phase.FLOP);
  ok(act(s, 1, { type: 'bet', amount: 100 }));
  ok(act(s, 2, { type: 'allin' })); // to 150: a raise of 50, short of 100
  ok(act(s, 3, { type: 'allin' })); // to 210: another 60, still short alone
  assert.equal(s.minRaise, 100);
  ok(act(s, 0, { type: 'call' }));
  const legal = legalActions(s, 1);
  assert.equal(legal.toCall, 110);
  assert.equal(legal.canRaise, true);
  ok(act(s, 1, { type: 'raise', amount: 400 }));
});

test('nobody may raise when no other seat can still act', () => {
  const s = newHand([100, 1000]);
  ok(act(s, 0, { type: 'allin' }));
  const legal = legalActions(s, 1);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.canCall, true);
  assert.equal(act(s, 1, { type: 'raise', amount: 1000 }).error, 'betting is closed to you');
});

test('a big blind that posted short all-in is already covered, so the hand runs out', () => {
  const s = newHand([1000, 3], { smallBlind: 5, bigBlind: 10 });
  assert.equal(s.phase, Phase.FINISHED);
  assert.equal(s.board.length, 5);
  assert.deepEqual(s.result.refund, { seat: 0, amount: 2 });
  assert.equal(s.result.net.reduce((a, b) => a + b, 0), 0);
});

test('the big blind may raise after everyone limps', () => {
  const s = newHand([1000, 1000, 1000]);
  ok(act(s, 0, { type: 'call' }));
  ok(act(s, 1, { type: 'call' }));
  assert.equal(legalActions(s, 2).canRaise, true);
});

test('the first postflop actor skips a folded or all-in seat left of the button', () => {
  const folded = newHand([1000, 1000, 1000, 1000]);
  ok(act(folded, 3, { type: 'call' }));
  ok(act(folded, 0, { type: 'call' }));
  ok(act(folded, 1, { type: 'fold' }));
  ok(act(folded, 2, { type: 'check' }));
  assert.equal(folded.phase, Phase.FLOP);
  assert.equal(folded.turn, 2);

  const shoved = newHand([1000, 10, 1000, 1000]);
  ok(act(shoved, 3, { type: 'call' }));
  ok(act(shoved, 0, { type: 'call' }));
  ok(act(shoved, 1, { type: 'call' })); // the small blind's last 5 chips
  assert.equal(shoved.players[1].allIn, true);
  ok(act(shoved, 2, { type: 'check' }));
  assert.equal(shoved.phase, Phase.FLOP);
  assert.equal(shoved.turn, 2);
});

test('an uncalled bet is refunded before pots are built', () => {
  const s = newHand([1000, 1000]);
  ok(act(s, 0, { type: 'raise', amount: 100 }));
  ok(act(s, 1, { type: 'fold' }));
  assert.deepEqual(s.result.refund, { seat: 0, amount: 90 });
  assert.equal(s.result.pots[0].amount, 20);
  assert.deepEqual(s.result.winnings, [110, 0]);
  assert.deepEqual(s.result.net, [10, -10]);
});

test('a shove met by a bigger stack is a call, so nothing is refunded', () => {
  const s = newHand([100, 1000]);
  rig(s, { 0: 'Ah Ad', 1: 'Kh Kd' }, '2c 7d 9h Jc 3d');
  ok(act(s, 0, { type: 'allin' }));
  const r = ok(act(s, 1, { type: 'allin' })); // can only call 100
  assert.equal(r.handEnded, true);
  assert.equal(s.result.refund, null);
  assert.equal(s.log.at(-1).action, 'call');
  assert.equal(s.result.pots.length, 1);
  assert.equal(s.result.pots[0].amount, 200);
  assert.deepEqual(s.result.pots[0].winners, [0]);
  assert.deepEqual(s.result.net, [100, -100]);
  assert.equal(s.board.length, 5);
});

test('blinds that leave nobody to act run the hand out at once', () => {
  const s = newHand([10, 1000], { smallBlind: 10, bigBlind: 20 });
  assert.equal(s.phase, Phase.FINISHED);
  assert.equal(s.board.length, 5);
  assert.equal(s.result.net.reduce((a, b) => a + b, 0), 0);
  assert.equal(s.result.refund.amount, 10);
});

function threeWayAllIn(holes) {
  const s = newHand([100, 300, 500]);
  rig(s, holes, '2c 7d 9h Jc 3d');
  ok(act(s, 0, { type: 'allin' }));
  ok(act(s, 1, { type: 'allin' }));
  ok(act(s, 2, { type: 'allin' }));
  return s;
}

test('three different stacks all-in: main pot and side pot, each to the right winner', () => {
  const s = threeWayAllIn({ 0: 'As Ah', 1: 'Ks Kh', 2: 'Qs Qh' });
  assert.equal(s.phase, Phase.FINISHED);
  assert.equal(s.result.refund, null); // the big stack can only call 300
  assert.deepEqual(s.result.pots.map((p) => [p.amount, p.eligible, p.winners]), [
    [300, [0, 1, 2], [0]],
    [400, [1, 2], [1]],
  ]);
  assert.equal(s.result.pots[0].handName, 'Pair of aces');
  assert.deepEqual(s.result.winnings, [300, 400, 0]);
  assert.deepEqual(s.result.net, [200, 100, -300]);
  assert.deepEqual(s.players.map((p) => p.stack), [300, 400, 200]);
  assert.deepEqual(s.result.shown, [0, 1, 2]);
  assert.equal(totalChips(s), 900);
});

test('the best hand holding the biggest stack takes both pots', () => {
  const s = threeWayAllIn({ 0: 'Qs Qh', 1: 'Ks Kh', 2: 'As Ah' });
  assert.deepEqual(s.result.pots.map((p) => p.winners), [[2], [2]]);
  assert.deepEqual(s.result.net, [-100, -300, 400]);
});

test('a split pot gives the odd chip to the first winner left of the button', () => {
  // Seat 1 folds its small blind, leaving 2 + 2 + 2 + 1 = 7 in the middle.
  const s = newHand([1000, 1000, 1000, 1000], { button: 0, smallBlind: 1, bigBlind: 2 });
  rig(s, { 0: 'Ah 2d', 1: '5c 6d', 2: 'Ac 3d', 3: '4c 4d' }, 'Ks Kh Qs Qh Js');
  ok(act(s, 3, { type: 'call' }));
  ok(act(s, 0, { type: 'call' }));
  ok(act(s, 1, { type: 'fold' }));
  ok(act(s, 2, { type: 'check' }));
  checkdown(s);
  assert.equal(s.result.pots[0].amount, 7);
  assert.deepEqual(s.result.pots[0].winners, [0, 2]);
  assert.equal(s.result.pots[0].share, 3);
  // Left of the button (seat 0) the order is 1, 2, 3, 0: seat 2 is first.
  assert.deepEqual(s.result.winnings, [3, 0, 4, 0]);
  assert.deepEqual(s.result.net, [1, -1, 2, -2]);
  assert.equal(totalChips(s), 4000);
});

test('seatView shows opponents only at a showdown, never the deck, and carries the legal actions', () => {
  const s = newHand([1000, 1000, 1000]);
  const during = seatView(s, 0);
  assert.equal(during.players[1].hole, null);
  assert.equal(during.pot, 15);
  assert.ok(during.legal.canCall);
  assert.equal(seatView(s, 1).legal, null);
  assert.deepEqual(during.you.hole, s.players[0].hole);
  checkdown(s);
  const after = seatView(s, 0);
  assert.equal(after.players[1].hole.length, 2);
  assert.equal(after.players[2].hole.length, 2);
  assert.equal(JSON.stringify(after).includes('"deck"'), false);
});

test('chips are conserved across 200 random hands driven by a random legal-action picker', () => {
  const rng = makeRng('holdem-fuzz');
  for (let hand = 0; hand < 200; hand++) {
    const n = 2 + randInt(rng, 8);
    const stacks = [];
    for (let i = 0; i < n; i++) stacks.push(rng() < 0.12 ? 0 : 10 + randInt(rng, 500));
    if (stacks.filter((x) => x > 0).length < 2) stacks[0] = stacks[1] = 200;
    const button = nextButton(stacks.map((stack) => ({ stack })), randInt(rng, n) - 1);
    const s = newHand(stacks, { seed: `fuzz-${hand}`, button });
    const total = stacks.reduce((a, b) => a + b, 0);
    assert.equal(totalChips(s), total);

    let guard = 0;
    while (s.phase !== Phase.FINISHED) {
      assert.ok(guard++ < 300, 'hand did not end');
      const legal = legalActions(s, s.turn);
      assert.ok(legal, 'the seat on turn must have legal actions');
      const roll = rng();
      let action;
      if (roll < 0.12 && !legal.canCheck) action = { type: 'fold' };
      else if (roll < 0.2) action = { type: 'allin' };
      else if (roll < 0.5 && legal.canRaise) {
        action = { type: 'raise', amount: legal.minRaiseTo + randInt(rng, legal.maxRaiseTo - legal.minRaiseTo + 1) };
      } else action = { type: legal.canCheck ? 'check' : 'call' };
      ok(act(s, s.turn, action));
      assert.equal(totalChips(s), total, `hand ${hand}: chips changed mid-hand`);
      assert.ok(s.players.every((p) => p.stack >= 0));
    }
    assert.equal(s.players.reduce((a, p) => a + p.stack, 0), total, `hand ${hand}`);
    assert.equal(s.result.net.reduce((a, b) => a + b, 0), 0);
    assert.equal(s.result.winnings.reduce((a, b) => a + b, 0), s.result.pots.reduce((a, p) => a + p.amount, 0) + (s.result.refund?.amount ?? 0));
    assert.equal(s.turn, -1);
    if (s.result.showdown) assert.equal(s.board.length, 5);
  }
});
