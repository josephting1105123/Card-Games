import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFromId, parseHand } from '../src/core/cards.js';
import { Combo, beats, classify, describeCombo, feltLabel } from '../src/games/doudizhu/rules.js';

const c = (s) => classify(parseHand(s));
const type = (s) => c(s)?.type ?? null;

test('singles, pairs, trios and their kickers', () => {
  assert.equal(type('3'), Combo.SINGLE);
  assert.equal(type('X'), Combo.SINGLE);
  assert.equal(type('33'), Combo.PAIR);
  assert.equal(type('34'), null);
  assert.equal(type('xX'), Combo.ROCKET);
  assert.equal(type('333'), Combo.TRIO);
  assert.equal(type('3334'), Combo.TRIO_SINGLE);
  assert.equal(type('33344'), Combo.TRIO_PAIR);
  assert.equal(type('33345'), null, 'trio plus two unrelated singles is nothing');
  assert.equal(c('3334').rank, 3);
});

test('bombs and rockets', () => {
  assert.equal(type('3333'), Combo.BOMB);
  assert.equal(c('3333').bomb, true);
  assert.equal(c('xX').bomb, true);
  assert.equal(c('33').bomb, false);
  assert.throws(() => parseHand('xx'), /only one/, 'the deck holds one small joker');
  const twoSmallJokers = [cardFromId(52), cardFromId(52)];
  assert.equal(classify(twoSmallJokers), null, 'a repeated card is never a combination');
});

test('straights need five consecutive cards and stop at ace', () => {
  assert.equal(type('34567'), Combo.STRAIGHT);
  assert.equal(c('34567').length, 5);
  assert.equal(c('34567').rank, 7);
  assert.equal(type('3456'), null, 'four in a row is not a straight');
  assert.equal(type('34568'), null);
  assert.equal(type('TJQKA'), Combo.STRAIGHT);
  assert.equal(type('JQKA2'), null, 'a 2 may not join a chain');
  assert.equal(type('3456789TJQKA'), Combo.STRAIGHT, 'the longest straight is 3 to A');
});

test('pair chains need three consecutive pairs', () => {
  assert.equal(type('334455'), Combo.PAIR_CHAIN);
  assert.equal(c('334455').length, 3);
  assert.equal(type('3344'), null);
  assert.equal(type('33445566'), Combo.PAIR_CHAIN);
  assert.equal(type('KKAA22'), null, 'a 2 may not join a pair chain');
  assert.equal(type('QQKKAA'), Combo.PAIR_CHAIN);
});

test('aeroplanes with and without wings', () => {
  assert.equal(type('333444'), Combo.TRIO_CHAIN);
  assert.equal(c('333444').length, 2);
  assert.equal(type('33344456'), Combo.TRIO_CHAIN_SINGLES);
  assert.equal(c('33344456').rank, 4);
  assert.equal(type('3334445566'), Combo.TRIO_CHAIN_PAIRS);
  assert.equal(type('333444555678'), Combo.TRIO_CHAIN_SINGLES);
  assert.equal(type('333555'), null, 'trios must be consecutive');
  assert.equal(type('22233344'), null, 'a 2 may not head an aeroplane');
  assert.equal(type('3334445'), null, 'wrong number of wings');
});

test('four with two', () => {
  assert.equal(type('333356'), Combo.FOUR_TWO);
  assert.equal(type('333355'), Combo.FOUR_TWO);
  assert.equal(type('33335566'), Combo.FOUR_TWO_PAIRS);
  assert.equal(type('33335566'), Combo.FOUR_TWO_PAIRS);
  assert.equal(type('33335555'), null, 'two bombs are not a four-with-two');
  assert.equal(type('33334444'), Combo.TRIO_CHAIN_SINGLES,
    'splitting two bombs into an aeroplane with wings is legal, if usually unwise');
  assert.equal(type('3333456'), null);
});

test('beats(): same type, same length, higher rank', () => {
  assert.equal(beats(c('4'), c('3')), true);
  assert.equal(beats(c('3'), c('4')), false);
  assert.equal(beats(c('2'), c('A')), true);
  assert.equal(beats(c('x'), c('2')), true);
  assert.equal(beats(c('X'), c('x')), true);
  assert.equal(beats(c('44'), c('33')), true);
  assert.equal(beats(c('44'), c('3')), false, 'a pair does not answer a single');
  assert.equal(beats(c('45678'), c('34567')), true);
  assert.equal(beats(c('456789'), c('34567')), false, 'straight lengths must match');
  assert.equal(beats(c('4445'), c('3336')), true, 'only the trio decides');
  assert.equal(beats(c('3336'), c('4445')), false);
  assert.equal(beats(c('3'), null), true, 'leading allows anything legal');
  assert.equal(beats(null, c('3')), false);
});

test('beats(): bombs and rockets', () => {
  assert.equal(beats(c('3333'), c('AAA22')), true);
  assert.equal(beats(c('3333'), c('4444')), false);
  assert.equal(beats(c('4444'), c('3333')), true);
  assert.equal(beats(c('xX'), c('AAAA')), true);
  assert.equal(beats(c('AAAA'), c('xX')), false);
  assert.equal(beats(c('xX'), c('xX')), false);
  assert.equal(beats(c('AAA22'), c('3333')), false, 'nothing ordinary answers a bomb');
});

test('describeCombo reads sensibly', () => {
  assert.equal(describeCombo(null), 'Pass');
  assert.equal(describeCombo(c('33')), 'Pair 3');
  assert.match(describeCombo(c('34567')), /Straight/);
  assert.equal(describeCombo(c('xX')), 'Rocket');
});

// feltLabel() is the felt caption, not describeCombo()'s screen-reader text: it
// has to name a kicker's rank, which never made it into ComboInfo. Every hand
// below is run through classify() for real, so the label helper breaks the
// moment classify()'s output shape changes, not just when feltLabel() itself
// regresses.
const DASH = '–'; // en dash — feltLabel must never fall back to a hyphen
const label = (hand, lang) => {
  const cards = parseHand(hand);
  return feltLabel(classify(cards), cards, lang);
};

test('feltLabel: one assertion per combo shape, en', () => {
  assert.equal(label('7', 'en'), 'Single 7');
  assert.equal(label('99', 'en'), 'Pair 9');
  assert.equal(label('QQQ', 'en'), 'Trio Q');
  assert.equal(label('JJJ4', 'en'), 'Trio J + single 4');
  assert.equal(label('JJJ44', 'en'), 'Trio J + pair 4');
  assert.equal(label('34567', 'en'), `Straight 3${DASH}7`);
  assert.equal(label('55667788', 'en'), `Pairs 5${DASH}8`);
  assert.equal(label('777888', 'en'), `Aeroplane 7${DASH}8`);
  assert.equal(label('77788845', 'en'), `Aeroplane 7${DASH}8 + 2 singles`);
  assert.equal(label('7778884455', 'en'), `Aeroplane 7${DASH}8 + 2 pairs`);
  assert.equal(label('999945', 'en'), 'Four 9 + 2 singles');
  assert.equal(label('99994455', 'en'), 'Four 9 + 2 pairs');
  assert.equal(label('8888', 'en'), 'Bomb 8');
  assert.equal(label('xX', 'en'), 'Rocket');
});

test('feltLabel: one assertion per combo shape, zh', () => {
  assert.equal(label('7', 'zh'), '单张7');
  assert.equal(label('99', 'zh'), '对子9');
  assert.equal(label('QQQ', 'zh'), '三不带Q');
  assert.equal(label('JJJ4', 'zh'), '三J+单4');
  assert.equal(label('JJJ44', 'zh'), '三J+对4');
  assert.equal(label('34567', 'zh'), `顺子3${DASH}7`);
  assert.equal(label('55667788', 'zh'), `连对5${DASH}8`);
  assert.equal(label('777888', 'zh'), `飞机7${DASH}8`);
  assert.equal(label('77788845', 'zh'), `飞机7${DASH}8+2单`);
  assert.equal(label('7778884455', 'zh'), `飞机7${DASH}8+2对`);
  assert.equal(label('999945', 'zh'), '四9+2单');
  assert.equal(label('99994455', 'zh'), '四9+2对');
  assert.equal(label('8888', 'zh'), '炸弹8');
  assert.equal(label('xX', 'zh'), '王炸');
});

test('feltLabel: a kicker rank that coincides with the combo\'s own rank', () => {
  // Splitting two bombs (3333 4444) into an aeroplane with single wings is
  // legal (see the "aeroplanes with and without wings" test above), and it
  // leaves one leftover 3 and one leftover 4 — the same two ranks the
  // aeroplane itself spans. The label must still show both leftover cards,
  // not swallow them because their ranks already appear in the range.
  assert.equal(type('33334444'), Combo.TRIO_CHAIN_SINGLES);
  assert.equal(label('33334444', 'en'), `Aeroplane 3${DASH}4 + 2 singles`);
  assert.equal(label('33334444', 'zh'), `飞机3${DASH}4+2单`);
});

test('feltLabel: a chain of length 1 never prints a nonsense range', () => {
  // classify() can never itself hand back length === 1 for a chain type —
  // straights need 5 ranks, pair chains 3, aeroplanes 2 — so this reaches the
  // collapse branch of the internal range builder directly, by taking a real
  // classify() result and touching only the field under test.
  const cards = parseHand('55');
  const real = c('55');
  assert.equal(real.type, Combo.PAIR);
  const degenerate = { ...real, type: Combo.PAIR_CHAIN, length: 1 };
  const en = feltLabel(degenerate, cards, 'en');
  const zh = feltLabel(degenerate, cards, 'zh');
  assert.equal(en, 'Pairs 5');
  assert.equal(zh, '连对5');
  assert.ok(!en.includes(DASH), 'a single-rank chain must not read as a range');
  assert.ok(!zh.includes(DASH), 'a single-rank chain must not read as a range');
});
