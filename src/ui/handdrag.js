/**
 * Arranging your own hand by dragging cards, shared by both card tables.
 *
 * Two halves. arrangeHand() and handReplaced() are pure (no DOM), so the order
 * rules can be tested under node. enableHandDrag() is the pointer wiring: it
 * moves and slides cards with CSS only and reports the finished order back, and
 * the view that owns the hand decides what to do with it.
 */

// Sideways travel before a press stops being a click and becomes a drag.
const THRESHOLD = 8;
// A dropped card eases into its slot for --dur-fast (120ms); the order is only
// committed, and the fan rebuilt, once that has played out.
const SETTLE_MS = 140;

/**
 * The hand in the order it should be shown: the player's own order where there
 * is one, the default sort otherwise.
 *
 * `custom` can be stale. Played cards are simply gone from `sorted`, and a card
 * the order has never seen (the landlord's three, picked up after bidding) is
 * missing from it. Such a card goes where the default sort puts it relative to
 * its neighbours, directly after the card that precedes it by default, or
 * before the first placed card when it would have led the hand. Taken in
 * default order, a run of new cards keeps its sequence.
 * @template {{id: number}} C
 * @param {C[]} sorted the hand in default order
 * @param {number[]|null|undefined} custom card ids, in the player's order
 * @returns {C[]}
 */
export function arrangeHand(sorted, custom) {
  if (!custom?.length) return sorted;
  const byId = new Map(sorted.map((card) => [card.id, card]));
  const placed = [];
  const seen = new Set();
  for (const id of custom) {
    const card = byId.get(id);
    if (!card || seen.has(id)) continue;
    placed.push(card);
    seen.add(id);
  }
  if (!placed.length) return sorted;
  for (let i = 0; i < sorted.length; i++) {
    const card = sorted[i];
    if (seen.has(card.id)) continue;
    let at;
    if (i > 0) {
      // sorted[i - 1] is always placed by now: it was there already or was just inserted.
      at = placed.indexOf(sorted[i - 1]) + 1;
    } else {
      const next = sorted.find((other) => seen.has(other.id));
      at = placed.indexOf(next);
    }
    placed.splice(at, 0, card);
    seen.add(card.id);
  }
  return placed;
}

/**
 * True when `next` cannot be the same hand as `previous` after plays or a
 * pickup: it gained a card and lost one. A hand only ever shrinks as cards are
 * played, or grows (the landlord's three), never both, so this is a fresh deal
 * and a custom order from the last one means nothing.
 * @param {{id: number}[]} previous
 * @param {{id: number}[]} next
 */
export function handReplaced(previous, next) {
  const had = new Set(previous.map((card) => card.id));
  const has = new Set(next.map((card) => card.id));
  return next.some((card) => !had.has(card.id)) && previous.some((card) => !has.has(card.id));
}

/**
 * Let the cards inside `inner` be dragged left and right.
 *
 * Expects what both hands render: `inner` holds nothing but `.card` elements,
 * in display order, each with data-card-id, laid out at a fixed step. A press
 * that moves less than 8px stays an ordinary click. Past that the card lifts
 * and follows the pointer, the cards it passes slide over to open its slot, and
 * on release it settles there. All of it is `--dx` custom properties and the
 * `.is-dragging` / `.is-dropping` classes; table.css and big2.css turn those
 * into transforms.
 *
 * `canDrag()` is asked at the moment of each press. `onDrop(ids)` runs once the
 * gesture is over: `ids` is the whole hand's new left-to-right order if a card
 * moved, `null` if it ended where it began or the gesture was cancelled (the
 * cards are put back). The view must not rebuild the cards while `busy` is
 * true, which is why it is exposed; `onDrop` is its cue to catch up.
 * @param {HTMLElement} inner
 * @param {{canDrag?: () => boolean, onDrop: (ids: number[]|null) => void}} options
 * @returns {{readonly busy: boolean, destroy: () => void}}
 */
export function enableHandDrag(inner, { canDrag = () => true, onDrop }) {
  let press = null; // the pointer that is down on a card
  let settling = null; // timer while a dropped or cancelled card eases home
  let swallowClick = false;

  const idOf = (card) => Number(card.dataset.cardId);

  function slide(p) {
    p.cards.forEach((card, i) => {
      if (i === p.from) return;
      const toLeft = p.from < p.to && i > p.from && i <= p.to;
      const toRight = p.to < p.from && i >= p.to && i < p.from;
      if (toLeft) card.style.setProperty('--dx', `${-p.step}px`);
      else if (toRight) card.style.setProperty('--dx', `${p.step}px`);
      else card.style.removeProperty('--dx');
    });
  }

  function putBack(p) {
    for (const card of p.cards) {
      card.classList.remove('is-dragging', 'is-dropping');
      card.style.removeProperty('--dx');
    }
  }

  function settle(p, ids) {
    settling = setTimeout(() => {
      settling = null;
      swallowClick = false;
      onDrop(ids);
    }, SETTLE_MS);
  }

  inner.addEventListener('pointerdown', (e) => {
    // A second finger, or a press while the last card is still easing home.
    if (settling || (press && press.node.isConnected)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swallowClick = false;
    const node = e.target.closest?.('.card');
    if (!node || node.parentElement !== inner || node.disabled || !canDrag()) return;
    const cards = Array.from(inner.children);
    if (cards.length < 2) return;
    // offsetLeft is layout, so unlike getBoundingClientRect it ignores the
    // lift and slide transforms already on the cards.
    const step = cards[1].offsetLeft - cards[0].offsetLeft;
    if (!(step > 0)) return;
    // Without capture a quick flick leaves the card and the drag with it. Touch
    // captures implicitly; a mouse needs asking.
    try { node.setPointerCapture(e.pointerId); } catch { /* still works as a click */ }
    const from = cards.indexOf(node);
    press = { node, cards, from, to: from, step, startX: e.clientX, id: e.pointerId, active: false };
  });

  inner.addEventListener('pointermove', (e) => {
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.startX;
    if (!p.active) {
      if (Math.abs(dx) <= THRESHOLD) return;
      p.active = true;
      swallowClick = true;
      p.node.classList.add('is-dragging');
    }
    const last = p.cards.length - 1;
    // The card follows the pointer, but never past the first or last slot.
    const x = Math.max(-p.from * p.step, Math.min((last - p.from) * p.step, dx));
    p.node.style.setProperty('--dx', `${x}px`);
    const to = Math.max(0, Math.min(last, Math.round(p.from + x / p.step)));
    if (to !== p.to) {
      p.to = to;
      slide(p);
    }
  });

  function release(p) {
    press = null;
    try { p.node.releasePointerCapture(p.id); } catch { /* already released */ }
  }

  inner.addEventListener('pointerup', (e) => {
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    release(p);
    // A plain click: the click handler takes it from here. The view held off
    // any repaint while the finger was down, so let it catch up.
    if (!p.active) { onDrop(null); return; }
    // Drop: the card eases from the pointer into its slot, its lift fades.
    p.node.classList.remove('is-dragging');
    p.node.classList.add('is-dropping');
    p.node.style.setProperty('--dx', `${(p.to - p.from) * p.step}px`);
    let ids = null;
    if (p.to !== p.from) {
      ids = p.cards.map(idOf);
      ids.splice(p.to, 0, ...ids.splice(p.from, 1));
    }
    settle(p, ids);
  });

  function cancel(e) {
    const p = press;
    if (!p || e.pointerId !== p.id) return;
    release(p);
    swallowClick = false;
    if (!p.active) { onDrop(null); return; }
    putBack(p);
    settle(p, null);
  }
  inner.addEventListener('pointercancel', cancel);
  // Capture taken away mid-drag (the card was removed, the window lost focus).
  inner.addEventListener('lostpointercapture', cancel);

  // The browser still sends a click after a drag. Taken on the way down, before
  // the card's own handler sees it, so dropping a card does not also select it.
  inner.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  return {
    get busy() { return !!settling || !!(press && press.node.isConnected); },
    destroy() {
      clearTimeout(settling);
      settling = null;
      press = null;
    },
  };
}
