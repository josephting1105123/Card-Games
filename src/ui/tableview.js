/**
 * The table, rendered from a seat view.
 *
 * One class serves both modes: a solo game feeds it engine.seatView(state, 0),
 * and a LAN game feeds it the view the server sends. It never touches the engine
 * itself, so it cannot accidentally read a hand it is not allowed to see.
 *
 * Callbacks out: onBid(points), onPlay(cards), onPass(), onLeave().
 */

import { cardsToString, sortCards } from '../core/cards.js';
import { SOLO_CURRENCY, currencyLabel, currencyTint, formatAmount, formatMoney } from '../core/currency.js';
import { Phase } from '../games/doudizhu/engine.js';
import { beats, classify, comboName, describeCombo } from '../games/doudizhu/rules.js';
import { findHint, legalPlays } from '../games/doudizhu/moves.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el, wait } from './dom.js';
import { enableTableFullscreen } from './fullscreen.js';

// Every card on this table uses the "bold" style (spec: cardElement(card, {
// style: 'bold' })) — Dou Di Zhu is the only table built on it so far.
const BOLD = { style: 'bold' };

/**
 * Run one leg of a deal flyer's flight: write the ten "from"/"to" custom
 * properties the shared cg-fly keyframe (table.css) reads, then restart the
 * animation. Every position is a plain number of pixels off the dealer
 * stack's own measured centre (dealIn's one measurement pass) — never vw/vh,
 * never re-measured. Only transform and opacity ever move.
 * @param {HTMLElement} card
 * @param {{fx?: number, fy?: number, fr?: number, fs?: number, fo?: number,
 *          tx?: number, ty?: number, tr?: number, ts?: number, to?: number,
 *          dur: number}} p
 */
function flyTo(card, p) {
  const set = (name, value, unit = '') => card.style.setProperty(name, `${value ?? 0}${unit}`);
  set('--fx', p.fx, 'px'); set('--fy', p.fy, 'px'); set('--fr', p.fr, 'deg');
  set('--fs', p.fs ?? 1); set('--fo', p.fo ?? 1);
  set('--tx', p.tx, 'px'); set('--ty', p.ty, 'px'); set('--tr', p.tr, 'deg');
  set('--ts', p.ts ?? 1); set('--to', p.to ?? 1);
  // Restart even if a previous cg-fly is still running on this element (the
  // opponent/self flyers each play several legs back to back).
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = `cg-fly ${p.dur}ms var(--ease) forwards`;
}

export class TableView {
  /**
   * @param {object} options
   * @param {HTMLElement} options.root
   * @param {{name: string, potLabel: string, lobbyName: string}} options.meta
   * @param {object} options.handlers
   */
  constructor({ root, meta, handlers }) {
    installCardDefs();
    this.root = root;
    this.meta = meta;
    this.currency = meta.currency ?? SOLO_CURRENCY;
    this.handlers = handlers;
    this.selected = new Set();
    this.view = null;
    this.hinted = new Set();
    this.build();
  }

  build() {
    clear(this.root);
    this.nodes = {};
    const n = this.nodes;

    // The head-up display carries three numbers and no sentences. Whose turn it
    // is was a pill of its own; the seat plates already ring the player on turn
    // and the controls enable, which says it without spending a word. The pot
    // rides along with the table's name instead of taking a pill.
    n.hudMult = el('span.hud__pill.hud__pill--mult', { title: 'Stake multiplier' }, el('b', '×2'));
    n.hudPurse = el('span.hud__pill', { style: `--pill-tint:${currencyTint(this.currency)}`, title: currencyLabel(this.currency) },
      el('small', currencyLabel(this.currency)),
      el('b', formatAmount(this.meta.bankroll ?? 0)));

    const hud = el('div.hud',
      el('button.back-link', { type: 'button', 'aria-label': 'Leave table', title: 'Leave table', onclick: () => this.handlers.onLeave?.() }, '←'),
      el('span.hud__pill.hud__pill--table', el('b', `${this.meta.lobbyName} · ${this.meta.potLabel}`)),
      el('div.hud__spacer'),
      n.hudMult, n.hudPurse,
    );

    n.leftSeat = this.buildSeat('left');
    n.rightSeat = this.buildSeat('right');
    n.bottomRow = el('div.bottom-cards__row');
    // Pinned under the HUD, small: the caption cost a line of height a card
    // strip this size can't spare, so it moved to an aria-label instead of a
    // visible line — screen readers still get "Landlord's three", sighted
    // players get the cards themselves, which is what the caption described.
    n.bottom = el('div.bottom-cards', { 'aria-label': 'Landlord’s three' }, n.bottomRow);
    // One landing area per seat, laid out where that player sits. A pile in the
    // middle with a caption underneath made you read to find out who had moved;
    // this way the answer is where the cards are.
    const playZone = (slot) => el(`div.play.play--${slot}`, el('div.play__cards'), el('span.play__name'));
    n.plays = { left: playZone('left'), right: playZone('right'), self: playZone('self') };
    n.bidPanel = el('div.bid-panel', { hidden: true });

    // Controls float over the felt, just above the hand, the way the
    // reference floats its Fight/Skip buttons — a row of its own under the
    // hand is exactly the height that stops the fan being big enough to read.
    n.comboLabel = el('span.controls__you', '');
    n.hintBtn = el('button.btn', { type: 'button', onclick: () => this.showHint() }, 'Hint');
    n.passBtn = el('button.btn', { type: 'button', onclick: () => this.handlers.onPass?.() }, 'Pass');
    n.playBtn = el('button.btn.btn--primary', { type: 'button', onclick: () => this.playSelection() }, 'Play');
    n.role = el('span.controls__you', '');
    n.controls = el('div.controls', n.role, n.hintBtn, n.passBtn, n.playBtn, n.comboLabel);

    n.felt = el('div.felt', n.leftSeat.wrap, n.rightSeat.wrap, n.bottom,
      n.plays.left, n.plays.right, n.plays.self, n.bidPanel, n.controls);

    n.handInner = el('div.hand__inner');
    n.hand = el('div.hand', n.handInner);
    n.dock = el('div.dock', n.hand);

    n.table = el('div.table', hud, n.felt, n.dock);
    // The hand deliberately runs 18% off the bottom edge (spec 2), and a card
    // is a <button>: focusing one that is partly outside .table's own
    // overflow:hidden box makes the browser auto-scroll .table to reveal it,
    // which shunts the whole HUD and both seats upward. .table was never
    // meant to scroll at all, so any scroll it picks up snaps straight back.
    n.table.addEventListener('scroll', () => {
      n.table.scrollTop = 0;
      n.table.scrollLeft = 0;
    });
    this.root.append(
      n.table,
      el('div.rotate-gate',
        el('div',
          el('div.rotate-gate__icon', '↻'),
          el('h2', 'Turn your device'),
          el('p', 'Dou Di Zhu is dealt across the table. Landscape gives the fan room to breathe.'),
        ),
      ),
    );
    this.teardownFullscreen = enableTableFullscreen(n.table, hud);
  }

  buildSeat(side) {
    const avatar = el('span.seat__avatar', '?');
    const name = el('span.seat__name', '—');
    const count = el('span.seat__count', '17');
    const plate = el('div.seat__plate', avatar, name, count);
    const role = el('div.seat__role', '');
    const say = el('div.seat__say', '');
    const backs = el('div.seat__backs');
    const wrap = el(`div.seat.seat--${side}`, plate, role, backs, say);
    return { wrap, avatar, name, count, plate, role, say, backs };
  }

  /** Replace the whole displayed state. */
  update(view) {
    const previous = this.view;
    this.view = view;
    const handIds = new Set(view.you.hand.map((c) => c.id));
    for (const id of [...this.selected]) if (!handIds.has(id)) this.selected.delete(id);
    // seatView sends playedCards, never `plays` — reading the wrong field here
    // meant the comparison was undefined !== undefined and the hint highlight
    // stayed lit into the next trick.
    if (previous && previous.playedCards?.length !== view.playedCards?.length) this.hinted.clear();

    // Calls belong to bidding. Once cards are down they are stale, so they go.
    if (previous && previous.phase === Phase.BIDDING && view.phase !== Phase.BIDDING) {
      this.clearSpeech();
    }

    // Worked out once per update: it decides the greying, the hand's signature
    // and which buttons are live, and legalPlays is not free.
    this.stuck = this.isYourPlayTurn() && !!view.trick
      && legalPlays(view.you.hand, view.trick.combo).length === 0;

    this.renderSeats();
    this.renderBottom();
    this.renderPlays();
    this.renderBidding();
    this.renderHand();
    this.renderControls();
    this.renderHud();
  }

  setBankroll(value) {
    this.meta.bankroll = value;
    this.nodes.hudPurse.querySelector('b').textContent = formatAmount(value);
  }

  /** Amounts shown at this table, in this table's currency. */
  money(value, compact = false) {
    return formatMoney(value, this.currency, compact);
  }

  /** A short line above an opponent, e.g. "Pass" or "Three of a kind". */
  say(seat, text) {
    const node = this.seatNodeFor(seat);
    if (!node) return;
    node.say.textContent = text;
    node.say.classList.add('is-on');
    clearTimeout(node._sayTimer);
    node._sayTimer = setTimeout(() => node.say.classList.remove('is-on'), 2200);
  }

  /** Animations are off under prefers-reduced-motion, or by the player's setting. */
  animationsOn() {
    if (this.meta.animations === false) return false;
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  /**
   * Shuffle the deck and deal it out, before a hand starts. Presentation
   * only — the engine has already dealt; `this.view` already holds the real
   * final state (renderHand/renderSeats/renderBottom/renderBidding already
   * built the real DOM for it, in build()'s update() call that ran just
   * before this). dealIn() hides that real DOM behind `is-dealing-*` and
   * plays flyers over it, then hands over.
   *
   * Sequence (spec 3): a face-down stack spreads and squares up; 51 cards
   * leave it one at a time, round-robin (left, right, you); your 17th lands,
   * the hand holds, gathers to its centre and re-spreads sorted; the last 3
   * slide to the landlord's three; the bid panel appears. ~3.0-4.5s total.
   *
   * A flyer is never removed while the real card it stands for is still
   * hidden: an opponent's back or a landlord's-three card is revealed and
   * its flyer removed in the same synchronous step; the hand's 17 flyers
   * stand in for the real hand the whole time and are only swapped out, all
   * at once, once the real hand (already built, already sorted) is unhidden
   * — which happens in the same synchronous step as removing them, so nothing
   * is ever visibly missing for a frame.
   *
   * Every position used below is measured exactly once, right after the
   * flourish, from the real (hidden but laid-out) destinations — never
   * guessed, never re-measured mid-flight.
   *
   * A tap/click anywhere on the table skips straight to the end state: every
   * `await` below is raced against a shared "skipped" promise that a listener
   * resolves on first pointerdown, so no step outlives a skip by more than
   * the current microtask.
   */
  async dealIn() {
    if (!this.animationsOn()) return;
    const view = this.view;
    const table = this.nodes.table;
    const felt = this.nodes.felt;
    const N = view.you.hand.length; // 17, pre-bid — the round-robin's per-seat count

    table.classList.add('is-dealing-left', 'is-dealing-right', 'is-dealing-self', 'is-dealing-bottom', 'is-dealing-bid');

    let skipped = false;
    let resolveSkip;
    const skipPromise = new Promise((resolve) => { resolveSkip = resolve; });
    const onTap = () => { skipped = true; resolveSkip(); };
    table.addEventListener('pointerdown', onTap, { capture: true });
    // Every wait in this method goes through here: a skip resolves it within
    // the same microtask, so whichever `await` is current returns immediately.
    const race = (ms) => Promise.race([wait(ms), skipPromise]);
    this.dealSkip = { cancel: () => { if (!skipped) onTap(); } };

    const dealer = el('div.dealer');
    felt.append(dealer);
    this.dealer = dealer;

    const finish = () => {
      table.removeEventListener('pointerdown', onTap, { capture: true });
      dealer.remove();
      if (this.dealer === dealer) this.dealer = null;
      table.classList.remove('is-dealing-left', 'is-dealing-right', 'is-dealing-self', 'is-dealing-bottom', 'is-dealing-bid');
      // Belt and suspenders: a fire-and-forget landing callback (below) can
      // still fire after this runs. Clearing the inline opacity it set is
      // harmless either way, since the class that hid these is already gone.
      for (const child of [...this.nodes.leftSeat.backs.children, ...this.nodes.rightSeat.backs.children, ...this.nodes.bottomRow.children]) {
        child.style.opacity = '';
      }
    };

    // --- phase 0: a face-down stack spreads into a fan, then squares up ---
    const FAN_N = 7;
    const flourish = [];
    for (let i = 0; i < FAN_N; i++) {
      const card = cardElement(null, { faceDown: true, style: 'bold' });
      card.classList.add('dealer__card');
      dealer.append(card);
      flourish.push(card);
    }
    const mid = (FAN_N - 1) / 2;
    flourish.forEach((card, i) => {
      const spread = i - mid;
      flyTo(card, { tx: spread * 15, ty: -Math.abs(spread) * 4, tr: spread * 6, dur: 350 });
    });
    await race(350);
    if (skipped) return finish();
    flourish.forEach((card, i) => {
      const spread = i - mid;
      flyTo(card, { fx: spread * 15, fy: -Math.abs(spread) * 4, fr: spread * 6, dur: 250 });
    });
    await race(250);
    if (skipped) return finish();
    // One card stays as the visible stack the rest of the deal flies out of.
    for (const card of flourish.slice(1)) card.remove();
    const stack = flourish[0];

    // --- measure every destination once, before any flight starts ---------
    const anchor = dealer.getBoundingClientRect();
    const anchorX = anchor.left + anchor.width / 2;
    const anchorY = anchor.top + anchor.height * 0.16; // matches .dealer__card { top: 16% }
    const deckCardWidth = stack.getBoundingClientRect().width;
    const offsetOf = (rect) => ({
      tx: rect.left + rect.width / 2 - anchorX,
      ty: rect.top + rect.height / 2 - anchorY,
    });

    const handCards = [...this.nodes.handInner.children]; // real, hidden, already sorted left-to-right
    const handSlots = handCards.map((c) => c.getBoundingClientRect());
    const handCardWidth = (handCards[0] ?? this.nodes.handInner).getBoundingClientRect().width || deckCardWidth;
    const sortedHand = sortCards(view.you.hand);
    const sortedIndexById = new Map(sortedHand.map((c, i) => [c.id, i]));
    const shuffledHand = [...view.you.hand].sort(() => Math.random() - 0.5);

    const leftChildren = [...this.nodes.leftSeat.backs.children];
    const rightChildren = [...this.nodes.rightSeat.backs.children];
    const leftRects = leftChildren.map((c) => c.getBoundingClientRect());
    const rightRects = rightChildren.map((c) => c.getBoundingClientRect());
    const backCardWidth = (leftChildren[0] ?? this.nodes.leftSeat.backs).getBoundingClientRect().width || deckCardWidth;

    const bottomChildren = [...this.nodes.bottomRow.children];
    const bottomRects = bottomChildren.map((c) => c.getBoundingClientRect());
    const bottomCardWidth = (bottomChildren[0] ?? this.nodes.bottomRow).getBoundingClientRect().width || deckCardWidth;

    // --- phase 2: 51 flights, round-robin: left, right, you ---------------
    const STAGGER = 38;
    const FLIGHT = 300;
    const selfScale = handCardWidth / deckCardWidth;
    const backScale = backCardWidth / deckCardWidth;
    const selfFlyers = new Array(N);
    let leftCount = 0;
    let rightCount = 0;
    let selfCount = 0;

    const launchOpponent = (rects, children, cap, count) => {
      const idx = Math.min(count, cap - 1);
      const flyer = cardElement(null, { faceDown: true, style: 'bold' });
      flyer.classList.add('dealer__card');
      dealer.append(flyer);
      const { tx, ty } = offsetOf(rects[idx]);
      flyTo(flyer, { tx, ty, ts: backScale, dur: FLIGHT });
      // Fire-and-forget: reveals that seat's next back (the visible count
      // rises one at a time, as each flyer lands, not all together) and
      // removes the flyer in the same step — its target is visible before
      // it disappears, never after.
      (async () => {
        await race(FLIGHT);
        if (count < cap) children[count].style.opacity = '1';
        flyer.remove();
      })();
    };

    const order = [];
    for (let round = 0; round < N; round++) order.push('left', 'right', 'self');

    for (let n = 0; n < order.length; n++) {
      if (skipped) break;
      const seat = order[n];
      if (seat === 'left') { launchOpponent(leftRects, leftChildren, leftChildren.length, leftCount); leftCount++; }
      else if (seat === 'right') { launchOpponent(rightRects, rightChildren, rightChildren.length, rightCount); rightCount++; }
      else {
        const slot = selfCount; selfCount++;
        const card = shuffledHand[slot];
        const flyer = cardElement(card, { style: 'bold' });
        flyer.classList.add('dealer__card');
        dealer.append(flyer);
        selfFlyers[slot] = flyer;
        const { tx, ty } = offsetOf(handSlots[slot]); // next free slot, left to right
        flyTo(flyer, { fr: -12, tx, ty, tr: 0, ts: selfScale, dur: FLIGHT });
      }
      if (n < order.length - 1) await race(STAGGER);
    }
    if (!skipped) await race(FLIGHT); // let the very last flight (your 17th) land
    if (skipped) return finish();

    // --- phase 3: hold, then gather to the row's centre, then sorted ------
    await race(200);
    if (skipped) return finish();

    const handRow = this.nodes.handInner.getBoundingClientRect();
    const gather = offsetOf({ left: handRow.left, width: handRow.width, top: handRow.top, height: handRow.height });
    for (let slot = 0; slot < N; slot++) {
      const { tx: fx, ty: fy } = offsetOf(handSlots[slot]);
      flyTo(selfFlyers[slot], { fx, fy, fs: selfScale, tx: gather.tx, ty: gather.ty, ts: selfScale, dur: 250 });
    }
    await race(250);
    if (skipped) return finish();

    for (let slot = 0; slot < N; slot++) {
      const sortedIdx = sortedIndexById.get(shuffledHand[slot].id);
      // Every flyer starts this leg from the identical gather point and
      // diverges outward, so from the very first frame the correct paint
      // order is the *destination* (sorted) index, not the launch order
      // still baked into DOM order — left unset, a card moving left could
      // paint over its new left neighbour and bury that neighbour's index.
      selfFlyers[slot].style.zIndex = String(sortedIdx);
      const { tx, ty } = offsetOf(handSlots[sortedIdx]);
      flyTo(selfFlyers[slot], { fx: gather.tx, fy: gather.ty, fs: selfScale, tx, ty, ts: selfScale, dur: 300 });
    }
    await race(300);
    if (skipped) return finish();

    // --- phase 4: the last 3 cards slide to the landlord's three ----------
    stack.remove(); // the deck is now empty — nothing left to show a stack of
    const BOTTOM_STAGGER = 60;
    const BOTTOM_FLIGHT = 300;
    for (let i = 0; i < bottomChildren.length; i++) {
      if (skipped) break;
      const flyer = cardElement(null, { faceDown: true, style: 'bold' });
      flyer.classList.add('dealer__card');
      dealer.append(flyer);
      const { tx, ty } = offsetOf(bottomRects[i]);
      flyTo(flyer, { tx, ty, ts: bottomCardWidth / deckCardWidth, dur: BOTTOM_FLIGHT });
      const revealIndex = i;
      (async () => {
        await race(BOTTOM_FLIGHT);
        bottomChildren[revealIndex].style.opacity = '1';
        flyer.remove();
      })();
      if (i < bottomChildren.length - 1) await race(BOTTOM_STAGGER);
    }
    if (!skipped) await race(BOTTOM_FLIGHT);

    // --- done: reveal everything, remove every flyer, in one step ---------
    finish();
  }

  clearSpeech() {
    for (const node of [this.nodes.leftSeat, this.nodes.rightSeat]) {
      clearTimeout(node._sayTimer);
      node.say.classList.remove('is-on');
    }
  }

  seatNodeFor(seat) {
    const view = this.view;
    if (!view) return null;
    const left = (view.seat + 1) % 3;
    if (seat === left) return this.nodes.leftSeat;
    if (seat === (view.seat + 2) % 3) return this.nodes.rightSeat;
    return null;
  }

  renderHud() {
    const base = this.meta.baseMultiplier ?? 1;
    const shown = Math.max(this.view.multiplier, base);
    this.nodes.hudMult.querySelector('b').textContent = `×${shown}`;
    this.nodes.hudMult.classList.toggle('is-hot', shown > base);
  }

  renderSeats() {
    const view = this.view;
    for (const [offset, node] of [[1, this.nodes.leftSeat], [2, this.nodes.rightSeat]]) {
      const seat = (view.seat + offset) % 3;
      const player = view.players[seat];
      node.name.textContent = player.name;
      node.count.textContent = `${player.cards}`;
      node.avatar.textContent = player.name.slice(0, 1).toUpperCase();
      const isLandlord = seat === view.landlord;
      node.avatar.classList.toggle('is-landlord', isLandlord);
      node.role.textContent = view.landlord < 0 ? '' : isLandlord ? 'Landlord' : 'Farmer';
      const onTurn = view.phase === Phase.BIDDING ? view.bidding.turn : view.turn;
      node.plate.classList.toggle('is-turn', seat === onTurn && view.phase !== Phase.FINISHED);

      // The backs are identical, so add or remove the difference rather than
      // tearing down a dozen of them on every update.
      const shown = Math.min(player.cards, 12);
      while (node.backs.childElementCount > shown) node.backs.lastElementChild.remove();
      while (node.backs.childElementCount < shown) node.backs.append(cardElement(null, { faceDown: true, ...BOLD }));
    }
  }

  renderBottom() {
    const view = this.view;
    const signature = `${view.bottomRevealed}:${(view.bottom ?? []).map((c) => c?.id ?? 'x').join(',')}`;
    if (signature === this.bottomSignature) return;
    this.bottomSignature = signature;
    clear(this.nodes.bottomRow);
    for (const card of view.bottom ?? []) {
      this.nodes.bottomRow.append(cardElement(card, { faceDown: !card, ...BOLD }));
    }
  }

  /** Which seat sits in each of the three landing areas, from here. */
  seatForSlot(slot) {
    const me = this.view.seat;
    return slot === 'self' ? me : slot === 'left' ? (me + 1) % 3 : (me + 2) % 3;
  }

  /**
   * Lay the trick out one play per seat.
   *
   * Nothing here is captioned. The cards are in front of whoever played them,
   * the play still standing is the bright one, and a finished trick greys out
   * rather than vanishing, so the table can be read at a glance instead of
   * parsed. The only word on the felt is "Pass", because a pass has no cards to
   * show for itself.
   */
  renderPlays() {
    const view = this.view;
    const bidding = view.phase === Phase.BIDDING;
    const plays = view.trickPlays ?? [];
    const bySeat = new Map(plays.map((entry) => [entry.seat, entry]));
    const trickLive = !!view.trick;

    for (const slot of ['left', 'right', 'self']) {
      const zone = this.nodes.plays[slot];
      const seat = this.seatForSlot(slot);
      const entry = bySeat.get(seat);
      const key = bidding ? '' : entry ? (entry.pass ? 'pass' : entry.cards.map((c) => c.id).join(',')) : '';

      if (zone.dataset.key !== key) {
        zone.dataset.key = key;
        this.paintZone(zone, entry, slot, bidding);
      }
      const standing = !!entry && !entry.pass && trickLive && view.trick.leader === seat;
      zone.classList.toggle('is-empty', !key);
      // Bright while the trick it belongs to is still being fought over.
      zone.classList.toggle('is-stale', !!key && !trickLive);
      zone.classList.toggle('is-standing', standing);
      // Exactly one caption on the felt: what the play you have to beat is. Two
      // words at most, and only while it still stands.
      zone.querySelector('.play__name').textContent = standing ? shortName(entry.combo) : '';
      zone.title = entry && !entry.pass ? describeCombo(entry.combo) : '';
    }
  }

  paintZone(zone, entry, slot, bidding) {
    const cards = zone.querySelector('.play__cards');
    clear(cards);
    zone.classList.remove('is-entering');
    if (bidding || !entry) return;

    if (entry.pass) {
      cards.append(el('span.play__pass', 'Pass'));
    } else {
      sortCards(entry.cards).forEach((card, index) => {
        const node = cardElement(card, BOLD);
        node.style.setProperty('--i', String(index));
        cards.append(node);
      });
    }
    // Restart the deal-in animation: the cards travel from the seat that played
    // them, which is the other half of saying who moved without saying it.
    void zone.offsetWidth;
    zone.classList.add('is-entering');
    announce(this.describePlay(entry, slot));
  }

  /** Spoken for screen readers only; the felt itself stays wordless. */
  describePlay(entry, slot) {
    const view = this.view;
    const seat = this.seatForSlot(slot);
    const who = seat === view.seat ? 'You' : view.players[seat]?.name ?? 'Opponent';
    if (entry.pass) return `${who} passed`;
    return `${who} played ${describeCombo(entry.combo)}: ${cardsToString(entry.cards)}`;
  }

  renderBidding() {
    const view = this.view;
    const panel = this.nodes.bidPanel;
    if (view.phase !== Phase.BIDDING) {
      if (!panel.hidden) clear(panel);
      panel.hidden = true;
      this.bidSignature = null;
      return;
    }
    const signature = `${view.bidding.turn}:${view.bidding.highest}:${view.bidding.calls.length}`;
    if (signature === this.bidSignature) return;
    this.bidSignature = signature;
    const yours = view.bidding.turn === view.seat;
    clear(panel);
    panel.hidden = false;
    const highest = view.bidding.highest;
    panel.append(
      el('h2', yours ? 'Call for the landlord’s seat' : 'Bidding'),
      el('p', highest ? `Standing call: ${highest} point${highest > 1 ? 's' : ''}` : 'Nobody has called yet'),
    );
    if (!yours) {
      const waitingOn = view.players[view.bidding.turn]?.name ?? 'the next player';
      panel.append(el('p', `Waiting for ${waitingOn}…`));
      return;
    }
    const row = el('div.btn-row');
    row.append(el('button.btn', { type: 'button', onclick: () => this.handlers.onBid?.(0) }, 'Pass'));
    for (const value of [1, 2, 3]) {
      if (value <= highest) continue;
      row.append(el('button.btn.btn--primary', { type: 'button', onclick: () => this.handlers.onBid?.(value) }, `${value}`));
    }
    panel.append(row);
  }

  renderHand() {
    const view = this.view;
    const hand = sortCards(view.you.hand);
    // Rebuilding twenty cards costs real time on a phone, and most updates do
    // not touch the hand at all: a bot playing a card used to re-make the whole
    // fan. Skip when nothing that affects it has moved.
    const signature = [
      hand.map((c) => c.id).join(','),
      [...this.selected].sort().join(','),
      [...this.hinted].sort().join(','),
      this.stuck ? 'stuck' : '',
      this.root.clientWidth,
      this.root.clientHeight, // card height is vh-driven now, not just vw
    ].join('|');
    if (signature === this.handSignature) return;
    this.handSignature = signature;

    const inner = this.nodes.handInner;
    this.nodes.hand.classList.toggle('is-stuck', !!this.stuck);
    clear(inner);
    const width = this.cardWidth();
    // The fan spans up to ~94% of the viewport width; overlap never exceeds
    // half a card, but tightens to whatever actually fits a full 20-card hand.
    const available = this.root.clientWidth * 0.94;
    const step = hand.length > 1
      ? Math.min(width * 0.5, (available - width) / (hand.length - 1))
      : 0;
    inner.style.width = `${width + step * Math.max(0, hand.length - 1)}px`;
    inner.style.setProperty('--step', `${step}px`);

    hand.forEach((card, index) => {
      const node = cardElement(card, { selectable: true, ...BOLD });
      node.style.setProperty('--i', String(index));
      node.classList.toggle('is-selected', this.selected.has(card.id));
      node.classList.toggle('is-hinted', this.hinted.has(card.id));
      if (this.stuck) node.disabled = true;
      node.setAttribute('aria-pressed', this.selected.has(card.id) ? 'true' : 'false');
      node.addEventListener('click', () => this.toggle(card.id));
      inner.append(node);
    });
  }

  cardWidth() {
    const probe = this.nodes.handInner.querySelector('.card');
    if (probe) return probe.getBoundingClientRect().width || 70;
    // Mirrors .hand .card's --card-w clamp in table.css: a card height of at
    // least 28% of the viewport at 390px tall, 26% at 720px, width = height/1.4.
    const vh = this.root.clientHeight || 390;
    return Math.min(148, Math.max(72, vh * 0.205));
  }

  toggle(cardId) {
    if (!this.isYourPlayTurn() || this.stuck) return;
    if (this.selected.has(cardId)) this.selected.delete(cardId);
    else this.selected.add(cardId);
    this.hinted.clear();
    this.renderHand();
    this.renderControls();
  }

  selectCards(cards) {
    this.selected = new Set(cards.map((c) => c.id));
    this.renderHand();
    this.renderControls();
  }

  isYourPlayTurn() {
    return this.view?.phase === Phase.PLAYING && this.view.turn === this.view.seat;
  }

  selectionCards() {
    const byId = new Map(this.view.you.hand.map((c) => [c.id, c]));
    return [...this.selected].map((id) => byId.get(id)).filter(Boolean);
  }

  renderControls() {
    const view = this.view;
    const n = this.nodes;
    // The bid panel already owns the felt during bidding — Hint/Pass/Play have
    // nothing to do yet, and floating both over a short felt is how they
    // ended up overlapping.
    n.controls.classList.toggle('is-hidden', view.phase === Phase.BIDDING);
    if (view.phase === Phase.BIDDING) return;
    const yours = this.isYourPlayTurn();
    const cards = this.selectionCards();
    const combo = cards.length ? classify(cards) : null;
    const current = view.trick?.combo ?? null;
    const legal = !!combo && beats(combo, current);

    n.role.textContent = view.you.role === 'landlord' ? 'You are the landlord' : 'You are a farmer';
    // Nothing in the hand answers what is on the table: the fan greys out and
    // Pass is the only thing left to press, which says it without a sentence.
    n.playBtn.disabled = !yours || !legal || this.stuck;
    n.passBtn.disabled = !yours || !current;
    n.hintBtn.disabled = !yours || this.stuck;
    n.passBtn.classList.toggle('btn--primary', !!this.stuck);
    n.comboLabel.textContent = this.stuck || !cards.length
      ? ''
      : legal ? describeCombo(combo) : combo ? `${describeCombo(combo)} — does not beat it` : 'Not a combination';
  }

  playSelection() {
    const cards = this.selectionCards();
    const combo = classify(cards);
    if (!combo) return;
    this.handlers.onPlay?.(cards);
  }

  showHint() {
    const view = this.view;
    const hint = findHint(view.you.hand, view.trick?.combo ?? null);
    if (!hint) {
      announce('No legal play. You will have to pass.');
      this.nodes.comboLabel.textContent = 'Nothing beats that — pass';
      return;
    }
    this.hinted = new Set(hint.cards.map((c) => c.id));
    this.selectCards(hint.cards);
    announce(`Suggested: ${cardsToString(hint.cards)}`);
  }

  /** Full-screen result card. `onAgain` and `onLeave` are buttons on it. */
  showResult({ title, win, deltaText, lines, onAgain, onLeave, againLabel = 'Deal again' }) {
    const overlay = el('div.overlay',
      el('div.result',
        el('h2', { class: `result__title ${win ? 'is-win' : 'is-loss'}` }, title),
        el('div', { class: `result__delta ${win ? 'is-win' : 'is-loss'}` }, deltaText),
        el('ul.result__lines', ...lines.map((line) => el('li', { html: line }))),
        el('div.btn-row', { style: 'justify-content:center' },
          el('button.btn.btn--primary', { type: 'button', onclick: () => { overlay.remove(); onAgain?.(); } }, againLabel),
          el('button.btn', { type: 'button', onclick: () => { overlay.remove(); onLeave?.(); } }, 'Back to menu'),
        ),
      ),
    );
    this.root.append(overlay);
    return overlay;
  }

  destroy() {
    this.dealSkip?.cancel();
    this.dealer?.remove();
    this.dealer = null;
    this.teardownFullscreen?.();
    clear(this.root);
  }
}

/** "Pair", "Straight ×5" — short enough to sit under a play without shouting. */
function shortName(combo) {
  if (!combo) return '';
  const name = comboName(combo.type);
  return combo.length > 1 ? `${name} ×${combo.length}` : name;
}
