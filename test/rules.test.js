import test from 'node:test';
import assert from 'node:assert/strict';
import { cardFromId, parseHand } from '../src/core/cards.js';
import { Combo, beats, classify, describeCombo } from '../src/games/doudizhu/rules.js';

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
