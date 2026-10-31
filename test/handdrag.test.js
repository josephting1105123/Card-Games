import test from 'node:test';
import assert from 'node:assert/strict';

import { arrangeHand, handReplaced } from '../src/ui/handdrag.js';

// handdrag.js touches the DOM only inside enableHandDrag, so the order rules
// can be pinned here with no document at all.
const hand = (...ids) => ids.map((id) => ({ id }));
const idsOf = (cards) => cards.map((card) => card.id);

test('with no custom order the default sort is returned untouched', () => {
  const sorted = hand(5, 4, 3, 2);
  assert.equal(arrangeHand(sorted, null), sorted);
  assert.equal(arrangeHand(sorted, []), sorted);
});

test('a custom order that covers the hand is shown as it is', () => {
  assert.deepEqual(idsOf(arrangeHand(hand(5, 4, 3, 2), [2, 5, 3, 4])), [2, 5, 3, 4]);
});

test('played cards drop out of the order and the rest keep their places', () => {
  assert.deepEqual(idsOf(arrangeHand(hand(5, 3, 2), [2, 5, 4, 3])), [2, 5, 3]);
});

test('a card the order has never seen sits after its default predecessor', () => {
  // Default is 9 8 7 6 5; the player moved 9 to the far end. 7 is new.
  const sorted = hand(9, 8, 7, 6, 5);
  assert.deepEqual(idsOf(arrangeHand(sorted, [8, 6, 5, 9])), [8, 7, 6, 5, 9]);
});

test('new cards that lead the default sort go before their nearest placed successor', () => {
  // 9 and 8 lead the default 9 8 7 6, so with no card before them they sit just
  // ahead of 7, the first card of the default order the player's order holds.
  const sorted = hand(9, 8, 7, 6);
  assert.deepEqual(idsOf(arrangeHand(sorted, [6, 7])), [6, 9, 8, 7]);
});

test('a run of new cards keeps its default sequence', () => {
  const sorted = hand(9, 8, 7, 6, 5, 4);
  assert.deepEqual(idsOf(arrangeHand(sorted, [4, 9])), [4, 9, 8, 7, 6, 5]);
});

test('an order from another deal changes nothing it cannot place', () => {
  const sorted = hand(9, 8, 7);
  assert.deepEqual(idsOf(arrangeHand(sorted, [40, 41])), [9, 8, 7]);
});

test('duplicate ids in a stale order do not duplicate cards', () => {
  assert.deepEqual(idsOf(arrangeHand(hand(3, 2), [2, 2, 3])), [2, 3]);
});

test('an empty hand arranges to nothing', () => {
  assert.deepEqual(arrangeHand([], [1, 2]), []);
});

test('losing cards or gaining cards is the same deal, both is a new one', () => {
  assert.equal(handReplaced(hand(5, 4, 3), hand(5, 3)), false); // a play
  assert.equal(handReplaced(hand(5, 4, 3), hand(7, 5, 4, 3)), false); // the landlord's three
  assert.equal(handReplaced(hand(5, 4, 3), hand(9, 8, 7)), true);
  assert.equal(handReplaced(hand(5, 4, 3), hand(5, 4, 9)), true);
  assert.equal(handReplaced(hand(), hand(1, 2)), false); // caught by the finished-phase check instead
});
