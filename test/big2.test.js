import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFromId, cardId } from '../src/core/cards.js';
import { makeRng } from '../src/core/rng.js';
import {
  Combo, beats, cardValue, classify, comboName, describeCombo, fiveCardStrength,
} from '../src/games/big2/rules.js';
import { findHints, legalPlays, verifyMove } from '../src/games/big2/moves.js';
import {
  HAND_SIZE, Phase, SEATS, cardsInPlay, canPass, createGame, pass, play, seatView, settle,
} from '../src/games/big2/engine.js';
import { SKILLS, bestMove, chooseMove, skillByName } from '../src/games/big2/ai.js';
import { botTurn, runSeries, simulateGame } from '../src/games/big2/match.js';

// --- helpers ------------------------------------------------------------------

const RANK = { 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, T: 10, J: 11, Q: 12, K: 13, A: 14, 2: 15 };
/** A card of an exact rank+suit, built on core/cards.js's own id scheme. */
function card(rank, suit) {
  return cardFromId(cardId(RANK[rank] ?? rank, suit));
}
/** `hand([[3,'diamond'],[4,'club']])` — pairs of [rank, suit]. */
function makeHand(pairs) {
  return pairs.map(([r, s]) => card(r, s));
}
const c = (pairs) => classify(makeHand(pairs));

// --- F1: classify() and beats() ----------------------------------------------

test('single, pair and triple classify, and reject mismatched ranks', () => {
  assert.equal(c([[5, 'spade']]).type, Combo.SINGLE);
  assert.equal(c([[7, 'spade'], [7, 'diamond']]).type, Combo.PAIR);
  assert.equal(classify(makeHand([[3, 'spade'], [4, 'diamond']])), null, 'different ranks are not a pair');
  assert.equal(c([[7, 'spade'], [7, 'diamond'], [7, 'heart']]).type, Combo.TRIPLE);
  assert.equal(classify(makeHand([[3, 'spade'], [3, 'diamond'], [4, 'heart']])), null, 'not a triple');
});

test('no four-card play exists, even four of a kind alone', () => {
  const four = makeHand([[9, 'spade'], [9, 'heart'], [9, 'club'], [9, 'diamond']]);
  assert.equal(classify(four), null, 'Big Two has no four-card combination');
});

test('pairs and triples compare by their highest card, suit included', () => {
  // 7s7d beats 7h7c — the spec's own worked example.
  const strong = c([[7, 'spade'], [7, 'diamond']]);
  const weak = c([[7, 'heart'], [7, 'club']]);
  assert.equal(beats(strong, weak), true);
  assert.equal(beats(weak, strong), false);
  const triA = c([[9, 'spade'], [9, 'diamond'], [9, 'club']]);
  const triB = c([[9, 'heart'], [9, 'club'], [9, 'diamond']]);
  assert.equal(beats(triA, triB), true, '9s9d9c outranks 9h9c9d on the spade');
});

test('a higher rank always wins regardless of suit', () => {
  assert.equal(beats(c([['A', 'diamond']]), c([['K', 'spade']])), true);
  // The '2' card outranks the ace — "3 < 4 < ... < K < A < 2" — even on a weaker suit.
  assert.equal(beats(c([['2', 'diamond']]), c([['A', 'spade']])), true);
  assert.equal(beats(c([['A', 'diamond']]), c([['2', 'spade']])), false);
});

test('straights: A2345 lowest, JQKA2 highest, and the wrap stops at one use of the two', () => {
  assert.equal(c([['A', 'diamond'], ['2', 'club'], [3, 'heart'], [4, 'spade'], [5, 'diamond']]).type, Combo.STRAIGHT);
  assert.equal(c([['J', 'diamond'], ['Q', 'club'], ['K', 'heart'], ['A', 'spade'], ['2', 'diamond']]).type, Combo.STRAIGHT);
  assert.equal(c([[10, 'diamond'], ['J', 'club'], ['Q', 'heart'], ['K', 'spade'], ['A', 'diamond']]).type, Combo.STRAIGHT);
  // QKA23 and KA234 wrap the ladder a second time and are explicitly not straights.
  assert.equal(classify(makeHand([['Q', 'diamond'], ['K', 'club'], ['A', 'heart'], ['2', 'spade'], [3, 'diamond']])), null,
    'QKA23 is not a straight');
  assert.equal(classify(makeHand([['K', 'diamond'], ['A', 'club'], ['2', 'heart'], [3, 'spade'], [4, 'diamond']])), null,
    'KA234 is not a straight');
});

test('JQKA2 outranks A2345 by sequence position, not by the numeric rank of its cards', () => {
  const low = c([['A', 'diamond'], ['2', 'club'], [3, 'heart'], [4, 'spade'], [5, 'diamond']]); // A2345
  const high = c([['J', 'diamond'], ['Q', 'club'], ['K', 'heart'], ['A', 'spade'], ['2', 'diamond']]); // JQKA2
  assert.equal(beats(high, low), true);
  assert.equal(beats(low, high), false);
});

test('straight vs straight of the same sequence position ties on the suit of the sequence\'s top card', () => {
  // 34567: top card is the 7. Same window, different suit on the 7 only.
  const sevenDiamond = c([[3, 'diamond'], [4, 'club'], [5, 'heart'], [6, 'spade'], [7, 'diamond']]);
  const sevenSpade = c([[3, 'club'], [4, 'diamond'], [5, 'spade'], [6, 'heart'], [7, 'spade']]);
  assert.equal(beats(sevenSpade, sevenDiamond), true, 'spade (highest suit) outranks diamond on a tied straight');
  assert.equal(beats(sevenDiamond, sevenSpade), false);

  // A2345: top card is the 5, not the 2 or ace, even though both outrank a
  // bare 5 everywhere else in the game.
  const fiveClub = c([['A', 'heart'], ['2', 'spade'], [3, 'diamond'], [4, 'club'], [5, 'club']]);
  const fiveSpade = c([['A', 'club'], ['2', 'heart'], [3, 'spade'], [4, 'diamond'], [5, 'spade']]);
  assert.equal(beats(fiveSpade, fiveClub), true, "A2345 ties are broken on the suit of the '5', the notated top card");
});

test('flush vs flush by highest card value, rank then suit', () => {
  const lowFlush = c([[3, 'diamond'], [4, 'diamond'], [6, 'diamond'], [8, 'diamond'], [10, 'diamond']]);
  const highFlush = c([[3, 'spade'], [4, 'spade'], [6, 'spade'], [8, 'spade'], ['J', 'spade']]);
  assert.equal(lowFlush.type, Combo.FLUSH);
  assert.equal(beats(highFlush, lowFlush), true, 'J high beats 10 high');
  // Same top rank, different suit: suit breaks the tie.
  const kingDiamondFlush = c([[3, 'diamond'], [5, 'diamond'], [7, 'diamond'], [9, 'diamond'], ['K', 'diamond']]);
  const kingHeartFlush = c([[3, 'heart'], [5, 'heart'], [7, 'heart'], [9, 'heart'], ['K', 'heart']]);
  assert.equal(beats(kingHeartFlush, kingDiamondFlush), true, 'both K high, heart outranks diamond');
});

test('full house by the triple\'s rank, four of a kind by the quad\'s rank', () => {
  const house9 = c([[9, 'diamond'], [9, 'club'], [9, 'heart'], [4, 'spade'], [4, 'diamond']]);
  const house10 = c([[10, 'diamond'], [10, 'club'], [10, 'heart'], [4, 'club'], [4, 'heart']]);
  assert.equal(house9.type, Combo.FULL_HOUSE);
  assert.equal(describeCombo(house9), 'Full house, 9s');
  assert.equal(beats(house10, house9), true);

  const quad7 = c([[7, 'diamond'], [7, 'club'], [7, 'heart'], [7, 'spade'], [3, 'diamond']]);
  const quad9 = c([[9, 'diamond'], [9, 'club'], [9, 'heart'], [9, 'spade'], [3, 'club']]);
  assert.equal(quad7.type, Combo.FOUR_KIND);
  assert.equal(beats(quad9, quad7), true);
});

test('five-card ladder: straight < flush < full house < four of a kind < straight flush, regardless of raw key', () => {
  const highStraight = c([[10, 'diamond'], ['J', 'club'], ['Q', 'heart'], ['K', 'spade'], ['A', 'diamond']]); // top ace
  const lowFlush = c([[3, 'club'], [4, 'club'], [6, 'club'], [8, 'club'], [9, 'club']]); // top 9, non-consecutive
  assert.equal(beats(lowFlush, highStraight), true, 'a weak flush still beats a strong straight');

  const lowFullHouse = c([[3, 'diamond'], [3, 'club'], [3, 'heart'], [4, 'spade'], [4, 'diamond']]);
  const highFlush = c([[3, 'spade'], [5, 'spade'], [7, 'spade'], [9, 'spade'], ['A', 'spade']]);
  assert.equal(beats(lowFullHouse, highFlush), true, 'a weak full house still beats a strong flush');

  const lowFourKind = c([[3, 'diamond'], [3, 'club'], [3, 'heart'], [3, 'spade'], [4, 'diamond']]);
  const highFullHouse = c([['A', 'diamond'], ['A', 'club'], ['A', 'heart'], ['K', 'spade'], ['K', 'diamond']]);
  assert.equal(beats(lowFourKind, highFullHouse), true, 'a weak four of a kind still beats a strong full house');

  const lowStraightFlush = c([[3, 'diamond'], [4, 'diamond'], [5, 'diamond'], [6, 'diamond'], [7, 'diamond']]);
  const highFourKind = c([['A', 'diamond'], ['A', 'club'], ['A', 'heart'], ['A', 'spade'], ['K', 'diamond']]);
  assert.equal(beats(lowStraightFlush, highFourKind), true, 'a weak straight flush still beats a strong four of a kind');

  assert.equal(fiveCardStrength(Combo.STRAIGHT) < fiveCardStrength(Combo.FLUSH), true);
  assert.equal(fiveCardStrength(Combo.FLUSH) < fiveCardStrength(Combo.FULL_HOUSE), true);
  assert.equal(fiveCardStrength(Combo.FULL_HOUSE) < fiveCardStrength(Combo.FOUR_KIND), true);
  assert.equal(fiveCardStrength(Combo.FOUR_KIND) < fiveCardStrength(Combo.STRAIGHT_FLUSH), true);
});

test('a five-card hand beats only a five-card hand', () => {
  const single = c([['A', 'spade']]);
  const pair = c([[3, 'diamond'], [3, 'club']]);
  const triple = c([[4, 'diamond'], [4, 'club'], [4, 'heart']]);
  const five = c([[3, 'diamond'], [4, 'diamond'], [5, 'diamond'], [6, 'diamond'], [7, 'diamond']]);
  assert.equal(beats(five, single), false);
  assert.equal(beats(single, five), false);
  assert.equal(beats(five, pair), false);
  assert.equal(beats(five, triple), false);
  assert.equal(beats(pair, triple), false, 'size must match even between two non-five shapes');
});

test('comboName and describeCombo read naturally', () => {
  assert.equal(comboName(Combo.STRAIGHT_FLUSH), 'Straight flush');
  assert.equal(describeCombo(null), 'Pass');
  assert.equal(describeCombo(c([['K', 'spade']])), 'Single, K');
  assert.equal(describeCombo(c([[9, 'diamond'], [9, 'club']])), 'Pair, 9s');
});

test('classify rejects a repeated card and anything longer than five', () => {
  const repeated = [card(5, 'spade'), card(5, 'spade')];
  assert.equal(classify(repeated), null);
  const six = makeHand([[3, 'diamond'], [4, 'diamond'], [5, 'diamond'], [6, 'diamond'], [7, 'diamond'], [8, 'diamond']]);
  assert.equal(classify(six), null, 'Big Two never plays six cards at once');
});

// --- moves.js ------------------------------------------------------------------

test('legalPlays only offers plays that beat the current combo, in the same size', () => {
  const hand = makeHand([[4, 'diamond'], [8, 'club'], [8, 'heart'], [9, 'spade'], ['K', 'diamond'], ['A', 'club']]);
  const current = c([[7, 'spade']]);
  const answers = legalPlays(hand, current);
  assert.ok(answers.length > 0);
  for (const move of answers) {
    assert.equal(move.size, 1);
    assert.ok(beats(move, current));
    assert.ok(verifyMove(move));
  }
  // 4d does not beat a 7, so it must not appear.
  assert.ok(!answers.some((m) => m.cards[0].rank === 4));
});

test('mustInclude restricts leads to plays that contain a specific card', () => {
  const hand = makeHand([[3, 'diamond'], [3, 'club'], [4, 'heart'], [5, 'spade']]);
  const threeDiamond = card(3, 'diamond');
  const moves = legalPlays(hand, null, { mustInclude: threeDiamond.id });
  assert.ok(moves.length > 0);
  for (const move of moves) assert.ok(move.cards.some((c2) => c2.id === threeDiamond.id));
  // Sanity: without the restriction there are strictly more leads available.
  assert.ok(legalPlays(hand, null).length > moves.length);
});

test('findHints orders legal plays weakest first', () => {
  const hand = makeHand([[3, 'diamond'], [9, 'club'], ['K', 'heart']]);
  const current = c([[5, 'spade']]);
  const hints = findHints(hand, current);
  assert.deepEqual(hints.map((m) => m.rank), [9, 13], 'the 3 cannot beat a 5, so only 9 and K remain, weakest first');
});

// --- F1: engine.js — the 3d opening rule, passing, tricks ----------------------

const humanPlayers = () => [
  { name: 'You', isHuman: true },
  { name: 'Bot A' },
  { name: 'Bot B' },
  { name: 'Bot C' },
];

test('a deal gives four hands of 13 from a 52-card deck, no jokers', () => {
  const state = createGame({ seed: 'deal-1', players: humanPlayers() });
  assert.equal(state.phase, Phase.PLAYING);
  for (const hand of state.hands) assert.equal(hand.length, HAND_SIZE);
  const ids = new Set(state.hands.flat().map((c) => c.id));
  assert.equal(ids.size, 52, 'all 52 cards dealt exactly once');
  assert.ok(!state.hands.flat().some((c) => c.suit === 'joker'), 'Big Two has no jokers');
});

test('the seed determines the deal exactly', () => {
  const a = createGame({ seed: 'repeat-me', players: humanPlayers() });
  const b = createGame({ seed: 'repeat-me', players: humanPlayers() });
  assert.deepEqual(a.hands, b.hands);
  const different = createGame({ seed: 'not-the-same', players: humanPlayers() });
  assert.notDeepEqual(a.hands, different.hands);
});

test('the 3 of diamonds holder leads, and the opening play must contain it', () => {
  const state = createGame({ seed: 'open-1', players: humanPlayers() });
  const leader = state.turn;
  const threeDiamond = state.hands[leader].find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  assert.ok(threeDiamond, 'the seat on turn must be the one holding the 3 of diamonds');
  assert.equal(state.leadMustInclude, threeDiamond.id);

  // Try to open without it: pick any other card in that hand.
  const other = state.hands[leader].find((c2) => c2.id !== threeDiamond.id);
  const rejected = play(state, leader, [other]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /3 of diamonds/);

  // Opening with it succeeds, and the rule never applies again.
  const accepted = play(state, leader, [threeDiamond]);
  assert.equal(accepted.ok, true);
  assert.equal(state.leadMustInclude, null);
});

test('passing does not lock a seat out of the hand', () => {
  // A hand-built deal (rather than whatever seed 'pass-1' happens to deal)
  // so the seat that passes is guaranteed to hold a card that can beat the
  // leader's next lead — the point being tested, not an accident of the deal.
  const state = createGame({ seed: 'pass-1', players: humanPlayers() });
  const threeDiamond = card(3, 'diamond');
  state.hands = [
    // A spare filler card so playing the 3d and then the 9s does not empty
    // the leader's hand and end the game before this test is done with it.
    [threeDiamond, card(9, 'spade'), card(2, 'club')],
    [card('K', 'diamond'), card(4, 'club')],
    [card(5, 'heart')],
    [card(6, 'club')],
  ];
  state.turn = 0;
  state.leadMustInclude = threeDiamond.id;

  assert.equal(play(state, 0, [threeDiamond]).ok, true);
  const passer = state.turn; // seat 1
  assert.equal(pass(state, passer).ok, true);
  // Everyone else also passes, clearing the trick back to the leader...
  assert.equal(pass(state, state.turn).ok, true);
  assert.equal(pass(state, state.turn).ok, true);
  assert.equal(state.turn, 0, 'three passes hand the lead back to the last player to actually play');

  // ...and the leader opens a new trick. Turn order puts the seat that passed
  // before right back on turn immediately (leader -> passer -> ...): it can
  // still play normally, nothing about having passed excluded it.
  assert.equal(play(state, 0, [card(9, 'spade')]).ok, true);
  assert.equal(state.turn, passer);
  const backToPasser = play(state, passer, [card('K', 'diamond')]);
  assert.equal(backToPasser.ok, true, 'the seat that passed earlier can still play once the turn reaches it again');
});

test('three consecutive passes clear the trick and hand the lead to the last player', () => {
  const state = createGame({ seed: 'clear-1', players: humanPlayers() });
  const leader = state.turn;
  const threeDiamond = state.hands[leader].find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  play(state, leader, [threeDiamond]);
  assert.ok(state.trick, 'a trick is standing after the lead');

  assert.equal(pass(state, state.turn).ok, true);
  assert.equal(state.trick !== null, true, 'one pass does not clear the trick');
  assert.equal(pass(state, state.turn).ok, true);
  assert.equal(state.trick !== null, true, 'two passes do not clear the trick');
  assert.equal(pass(state, state.turn).ok, true);
  assert.equal(state.trick, null, 'the third consecutive pass clears the trick');
  assert.equal(state.turn, leader);
  assert.equal(state.passesInRow, 0);
});

test('a seat on lead may not pass', () => {
  const state = createGame({ seed: 'lead-pass-1', players: humanPlayers() });
  assert.equal(canPass(state, state.turn), false);
  const res = pass(state, state.turn);
  assert.equal(res.ok, false);
  assert.match(res.error, /lead/);
});

test('canPass agrees with pass(): true only in play, on turn, mid-trick', () => {
  const state = createGame({ seed: 'canpass-1', players: humanPlayers() });
  const leader = state.turn;
  const threeDiamond = state.hands[leader].find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  assert.equal(canPass(state, leader), false, 'leading: no trick to pass on');
  play(state, leader, [threeDiamond]);
  assert.equal(canPass(state, state.turn), true);
  assert.equal(canPass(state, (state.turn + 1) % SEATS), false, 'not their turn');
});

test('cardsInPlay always accounts for all 52 cards, in hand or played', () => {
  const state = createGame({ seed: 'conserve-1', players: humanPlayers() });
  assert.equal(cardsInPlay(state), 52);
  const leader = state.turn;
  const threeDiamond = state.hands[leader].find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  play(state, leader, [threeDiamond]);
  assert.equal(cardsInPlay(state), 52);
  pass(state, state.turn);
  assert.equal(cardsInPlay(state), 52);
});

test('seatView redacts other hands to counts but not the trick or history', () => {
  const state = createGame({ seed: 'view-1', players: humanPlayers() });
  const leader = state.turn;
  const threeDiamond = state.hands[leader].find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  play(state, leader, [threeDiamond]);
  const view = seatView(state, (leader + 1) % SEATS);
  assert.equal(view.you.hand.length, HAND_SIZE);
  for (const p of view.players) {
    if (p.seat !== view.seat) assert.equal(p.hand, undefined, 'no seat exposes another seat\'s hand');
  }
  assert.equal(view.trick.combo.cards[0].id, threeDiamond.id, 'the trick itself is public');
  assert.equal(view.turn, (leader + 1) % SEATS);
  assert.equal(view.leadMustInclude, null);
  assert.equal(view.history.length, 1);
});

// --- F1: settle() ---------------------------------------------------------------

test('settle() pays each loser\'s cardsLeft x rate to the winner, and nets to zero', () => {
  const state = createGame({ seed: 'settle-1', players: humanPlayers() });
  // Force a finish: give seat 0 a single card (the 3 of diamonds) and deal the
  // rest out arbitrarily among the other seats, then have it play out.
  const threeDiamond = state.hands.flat().find((c2) => c2.rank === 3 && c2.suit === 'diamond');
  const rest = state.hands.flat().filter((c2) => c2.id !== threeDiamond.id);
  state.hands = [[threeDiamond], rest.slice(0, 20), rest.slice(20, 40), rest.slice(40)];
  state.turn = 0;
  state.leadMustInclude = threeDiamond.id;
  assert.equal(play(state, 0, [threeDiamond]).ok, true);
  assert.equal(state.phase, Phase.FINISHED);
  assert.equal(state.winner, 0);

  const rate = 7;
  const { payouts, cardsLeft } = settle(state, rate);
  assert.deepEqual(cardsLeft, [0, 20, 20, 11]); // 52 - 1 (the 3d) = 51, split 20/20/11
  assert.equal(payouts.reduce((a, b) => a + b, 0), 0, 'settle() is zero-sum');
  assert.equal(payouts[1], -20 * rate);
  assert.equal(payouts[2], -20 * rate);
  assert.equal(payouts[3], -11 * rate);
  assert.equal(payouts[0], (20 + 20 + 11) * rate);
});

test('settle() on an unfinished hand pays nothing, still zero-sum', () => {
  const state = createGame({ seed: 'settle-unfinished', players: humanPlayers() });
  const { payouts } = settle(state, 5);
  assert.deepEqual(payouts, [0, 0, 0, 0]);
});

// --- F3: bot quality -------------------------------------------------------------

test('never an illegal move over 2,000 simulated hands; every hand terminates', () => {
  const skillNames = Object.keys(SKILLS);
  let fallbacks = 0;
  let totalSteps = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const skills = [
      skillNames[i % skillNames.length],
      skillNames[(i * 3 + 1) % skillNames.length],
      skillNames[(i * 5 + 2) % skillNames.length],
      skillNames[(i * 7 + 3) % skillNames.length],
    ];
    const { steps, actions } = simulateGame({ seed: `illegal-check:${i}`, skills });
    totalSteps += steps;
    for (const action of actions) {
      if (action.kind === 'fallback') fallbacks += 1;
    }
  }
  assert.equal(fallbacks, 0, `no bot decision should ever be illegal (saw ${fallbacks} over ${N} hands)`);
  assert.ok(totalSteps > N, 'sanity: real hands were played, not instant no-ops');
});

test('a seeded hand replays to the exact same sequence of actions', () => {
  const skills = ['grandmaster', 'expert', 'sharp', 'master'];
  const seeds = Array.from({ length: 30 }, (_, i) => `replay-check:${i}`);
  for (const seed of seeds) {
    const a = simulateGame({ seed, skills });
    const b = simulateGame({ seed, skills });
    assert.deepEqual(a.actions, b.actions, `seed ${seed} must replay identically`);
    assert.equal(a.winner, b.winner);
    assert.deepEqual(a.cardsLeft, b.cardsLeft);
  }
});

test('replay does not depend on the clock: ai.js never reads Date.now or performance.now', () => {
  const realPerfNow = globalThis.performance.now;
  const realDateNow = Date.now;
  const skills = ['grandmaster', 'expert', 'sharp', 'master'];
  const seeds = Array.from({ length: 10 }, (_, i) => `slow-clock:${i}`);
  const baselines = seeds.map((seed) => simulateGame({ seed, skills }));
  let clock = 0;
  globalThis.performance.now = () => { clock += 50; return clock; };
  Date.now = () => { clock += 50; return clock; };
  let stubbed;
  try {
    stubbed = seeds.map((seed) => simulateGame({ seed, skills }));
  } finally {
    globalThis.performance.now = realPerfNow;
    Date.now = realDateNow;
  }
  for (let i = 0; i < seeds.length; i++) {
    assert.deepEqual(stubbed[i].actions, baselines[i].actions, `seed ${seeds[i]}: a crawling clock must not change a single decision`);
  }
});

test('one-card blocking rule: forced to beat a single with the next seat down to one card, play the highest single', () => {
  const hand = makeHand([[7, 'diamond'], [9, 'club'], ['J', 'heart'], ['A', 'spade'], [4, 'club']]);
  const current = c([[6, 'spade']]);
  const view = {
    seat: 0,
    you: { seat: 0, hand },
    players: [
      { seat: 0, cards: hand.length },
      { seat: 1, cards: 1 }, // the very next seat is down to one card
      { seat: 2, cards: 8 },
      { seat: 3, cards: 8 },
    ],
    trick: { combo: current, seat: 3 },
    leadMustInclude: null,
  };
  for (const name of ['sharp', 'expert', 'master', 'grandmaster']) {
    const move = bestMove(view, SKILLS[name]);
    assert.equal(move.action, 'play');
    assert.equal(move.cards.length, 1);
    assert.equal(move.cards[0].rank, 14, `${name} should spend the highest single (the ace) to deny the one-card seat`);
  }
  // A tier below the rule's cutoff plays its usual cheapest legal answer instead.
  const relaxed = bestMove(view, SKILLS.novice);
  assert.equal(relaxed.cards[0].rank, 7, 'novice has no blocking discipline and just answers with its cheapest single');
});

test('does not break a made pair to answer a single when an unpaired card will do', () => {
  const hand = makeHand([[9, 'diamond'], [9, 'club'], [10, 'heart'], [3, 'spade']]);
  const current = c([[5, 'spade']]);
  const view = {
    seat: 0,
    you: { seat: 0, hand },
    players: [
      { seat: 0, cards: hand.length },
      { seat: 1, cards: 6 },
      { seat: 2, cards: 6 },
      { seat: 3, cards: 6 },
    ],
    trick: { combo: current, seat: 3 },
    leadMustInclude: null,
  };
  for (const name of ['casual', 'sharp', 'grandmaster']) {
    const move = bestMove(view, SKILLS[name]);
    assert.equal(move.cards.length, 1);
    assert.equal(move.cards[0].rank, 10, `${name} should play the unpaired 10, not cannibalise the pair of 9s`);
  }
});

test('strength ladder: expert vs three novices wins at least 40% (baseline 25%)', () => {
  const { games, wins } = runSeries({ games: 400, skills: ['expert', 'novice', 'novice', 'novice'], seedPrefix: 'ladder-expert' });
  const rate = wins[0] / games;
  console.log(`[big2] expert vs 3 novices: seat 0 (expert) won ${wins[0]}/${games} = ${(rate * 100).toFixed(1)}%`, wins);
  assert.ok(rate >= 0.40, `expert should win at least 40% of hands against three novices, got ${(rate * 100).toFixed(1)}%`);
});

test('strength ladder: grandmaster is at least as strong as expert head-to-head', () => {
  const { games, wins } = runSeries({
    games: 400, skills: ['grandmaster', 'expert', 'grandmaster', 'expert'], seedPrefix: 'ladder-gm-expert',
  });
  const gmWins = wins[0] + wins[2];
  const expertWins = wins[1] + wins[3];
  console.log(`[big2] grandmaster vs expert head-to-head over ${games} hands: gm=${gmWins}, expert=${expertWins}`, wins);
  assert.ok(gmWins >= expertWins, `grandmaster should win at least as often as expert, got gm=${gmWins} vs expert=${expertWins}`);
});

test('SKILLS is keyed exactly like doudizhu/ai.js, so lobby.skill works unchanged', () => {
  assert.deepEqual(Object.keys(SKILLS), ['novice', 'casual', 'steady', 'sharp', 'expert', 'master', 'grandmaster']);
  assert.equal(skillByName('sharp'), SKILLS.sharp);
  assert.equal(skillByName('not-a-real-skill'), SKILLS.steady, 'unknown skill names fall back to steady');
});

test('chooseMove always returns {action:"play",cards} or {action:"pass"}', () => {
  const state = createGame({ seed: 'shape-check', players: humanPlayers() });
  const view = seatView(state, state.turn);
  const move = chooseMove(view, SKILLS.steady, makeRng('shape-check:rng'));
  assert.ok(move.action === 'play' || move.action === 'pass');
  if (move.action === 'play') assert.ok(Array.isArray(move.cards) && move.cards.length > 0);
});

test('botTurn never has to fall back, across many seeds and skill assignments', () => {
  const rng = makeRng('botTurn-fuzz');
  for (let i = 0; i < 50; i++) {
    const state = createGame({
      seed: `fuzz:${i}`,
      players: [
        { name: 'a', skill: SKILLS.sharp },
        { name: 'b', skill: SKILLS.novice },
        { name: 'c', skill: SKILLS.grandmaster },
        { name: 'd', skill: SKILLS.expert },
      ],
    });
    let guard = 0;
    while (state.phase !== Phase.FINISHED) {
      if (++guard > 2000) throw new Error('fuzz game did not terminate');
      const acted = botTurn(state, rng);
      assert.notEqual(acted.kind, 'fallback', `botTurn had to fall back: ${JSON.stringify(acted)}`);
    }
  }
});
