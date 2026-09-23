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
import { beats, classify, describeCombo, feltLabel } from '../games/doudizhu/rules.js';
import { findHint, legalPlays } from '../games/doudizhu/moves.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el, wait } from './dom.js';

// Breathing room a landing area keeps from whatever it must not touch.
const FELT_GAP = 6;
// Left/right zones sit at this fraction of the felt's width in the common
// case (styles/table.css keeps the matching 24%/76%); used here only to work
// out how much of that width a wide play can safely use before it reaches a
// felt edge.
const SIDE_FRAC = 0.24;

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
    // Seat height and felt height both move with the viewport, so the trick's
    // landing areas have to be re-measured whenever it changes shape, not just
    // whenever a card is played.
    this.onResize = () => this.layoutFelt();
    globalThis.addEventListener?.('resize', this.onResize);
    this.layoutFelt();
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
    n.bottom = el('div.bottom-cards', el('span.bottom-cards__label', 'Landlord’s three'), n.bottomRow);
    // One landing area per seat, laid out where that player sits. A pile in the
    // middle with a caption underneath made you read to find out who had moved;
    // this way the answer is where the cards are.
    const playZone = (slot) => el(`div.play.play--${slot}`, el('div.play__cards'), el('span.play__name'));
    n.plays = { left: playZone('left'), right: playZone('right'), self: playZone('self') };
    n.bidPanel = el('div.bid-panel', { hidden: true });
    n.felt = el('div.felt', n.leftSeat.wrap, n.rightSeat.wrap, n.bottom,
      n.plays.left, n.plays.right, n.plays.self, n.bidPanel);

    n.handInner = el('div.hand__inner');
    n.hand = el('div.hand', n.handInner);
    n.comboLabel = el('span.controls__you', '');
    n.hintBtn = el('button.btn', { type: 'button', onclick: () => this.showHint() }, 'Hint');
    n.passBtn = el('button.btn', { type: 'button', onclick: () => this.handlers.onPass?.() }, 'Pass');
    n.playBtn = el('button.btn.btn--primary', { type: 'button', onclick: () => this.playSelection() }, 'Play');
    n.role = el('span.controls__you', '');
    n.controls = el('div.controls', n.role, n.hintBtn, n.passBtn, n.playBtn, n.comboLabel);
    n.dock = el('div.dock', n.hand, n.controls);

    n.table = el('div.table', hud, n.felt, n.dock);
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
    this.layoutFelt();
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
   * Shuffle the deck and deal it out, before a hand starts.
   *
   * Nine cards rather than fifty-four: it reads as dealing without making
   * anybody wait for it, and nine nodes is nothing next to the table it is
   * standing in front of. Everything moves on transform and opacity only, so it
   * stays on the compositor and costs no layout.
   *
   * A card is never destroyed on screen: `deal-out` lands at full opacity, at a
   * destination read from the real seats and hand rather than guessed, and the
   * real cards there only go visible once their seat's last flyer has landed —
   * on the same frame, so the felt is never briefly empty and nothing pops in
   * out of nowhere.
   */
  async dealIn() {
    if (!this.animationsOn()) return;
    const order = ['left', 'right', 'self'];
    const hideClass = { left: 'is-dealing-left', right: 'is-dealing-right', self: 'is-dealing-self' };
    const table = this.nodes.table;
    table.classList.add('is-dealing-left', 'is-dealing-right', 'is-dealing-self', 'is-dealing-bid');

    const dealer = el('div.dealer');
    const flyers = { left: [], right: [], self: [] };
    const lastIndex = {};
    for (let i = 0; i < 9; i++) {
      const slot = order[i % 3];
      lastIndex[slot] = i;
      const card = cardElement(null, { faceDown: true });
      card.classList.add('dealer__card');
      card.style.setProperty('--i', String(i));
      card.style.setProperty('--sx', i % 2 ? '26px' : '-26px');
      card.style.setProperty('--sr', i % 2 ? '7deg' : '-7deg');
      dealer.append(card);
      flyers[slot].push(card);
    }
    this.nodes.felt.append(dealer);
    this.dealer = dealer;

    dealer.classList.add('is-shuffling');
    await wait(560);
    if (!dealer.isConnected) return;

    // Measured once, right here, never inside the flight: is-dealing-* keeps
    // these at opacity 0 but they are laid out all along, so their rects are
    // real. Everything below is transform/opacity math from that one pass.
    const anchor = dealer.getBoundingClientRect();
    const anchorX = anchor.left + anchor.width / 2;
    const anchorY = anchor.top + anchor.height * 0.46;
    const flyerWidth = flyers.left[0].getBoundingClientRect().width;
    const containers = { left: this.nodes.leftSeat.backs, right: this.nodes.rightSeat.backs, self: this.nodes.handInner };
    for (const slot of order) {
      const container = containers[slot];
      const rect = container.getBoundingClientRect();
      const cardRect = (container.querySelector('.card') ?? container).getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - anchorX;
      const dy = rect.top + rect.height / 2 - anchorY;
      const scale = (cardRect.width || flyerWidth) / flyerWidth;
      for (const card of flyers[slot]) {
        card.style.setProperty('--dx', `${dx}px`);
        card.style.setProperty('--dy', `${dy}px`);
        card.style.setProperty('--ds', scale.toFixed(3));
      }
    }

    dealer.classList.remove('is-shuffling');
    dealer.classList.add('is-flying');

    // 45ms stagger, 260ms flight (both inside the spec's 45-60/260-320 range):
    // the round-robin order means each seat's *last* card lands a beat after
    // the one before it, so the reveals land in deal order for free.
    const STAGGER = 45;
    const FLIGHT = 260;
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const revealSeat = async (slot) => {
      await wait(lastIndex[slot] * STAGGER + FLIGHT);
      if (!dealer.isConnected) return;
      table.classList.remove(hideClass[slot]);
      // Hold the flyers one more frame so the browser paints the real cards
      // and the landed flyers together before the flyers disappear.
      await nextFrame();
      for (const card of flyers[slot]) card.remove();
    };
    await Promise.all(order.map(revealSeat));
    if (!dealer.isConnected) return;
    dealer.remove();
    this.dealer = null;

    // The bid panel has nothing to hand over to and no flight of its own, so
    // it needs no further wait: dealer.remove() above already only runs once
    // every seat, including the hand, is on the felt, which is all "arrives
    // last, after the hand is visible" asks for.
    table.classList.remove('is-dealing-bid');
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
      while (node.backs.childElementCount < shown) node.backs.append(cardElement(null, { faceDown: true }));
    }
  }

  renderBottom() {
    const view = this.view;
    const signature = `${view.bottomRevealed}:${(view.bottom ?? []).map((c) => c?.id ?? 'x').join(',')}`;
    if (signature === this.bottomSignature) return;
    this.bottomSignature = signature;
    clear(this.nodes.bottomRow);
    for (const card of view.bottom ?? []) {
      this.nodes.bottomRow.append(cardElement(card, { faceDown: !card }));
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
      zone.querySelector('.play__name').textContent = standing ? feltLabel(entry.combo, entry.cards) : '';
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
        const node = cardElement(card);
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

  /**
   * Where the trick lands, read off the seats and the hand around it rather
   * than a fraction of the felt: the felt's own height swings by hundreds of
   * pixels across the supported viewports while the seat block barely moves,
   * which is exactly why a percentage of it used to land the trick on top of
   * the seats on anything shorter than the viewport this was eyeballed at.
   *
   * Below the seat, above the hand, is the default. On a landscape phone too
   * short to fit a card row in that gap, the zone moves beside the seat
   * instead — width is the resource those viewports actually have to spare.
   * Either way, each zone's card row is then compressed, the same trick the
   * hand's fan already uses, to whatever room it actually landed in, so nine
   * cards never outgrow the lane a five-card play was measured for.
   */
  layoutFelt() {
    const { felt, dock, leftSeat, rightSeat, bottom, plays } = this.nodes;
    const feltRect = felt.getBoundingClientRect();
    if (!feltRect.height) return; // behind the rotate gate, or not yet in the document
    const dockTop = dock.getBoundingClientRect().top - feltRect.top;
    const leftSeatRect = leftSeat.wrap.getBoundingClientRect();
    const rightSeatRect = rightSeat.wrap.getBoundingClientRect();
    const bottomCardsRect = bottom.getBoundingClientRect();
    const seatBottom = Math.max(leftSeatRect.bottom, rightSeatRect.bottom) - feltRect.top;
    const seatWidth = Math.max(leftSeatRect.width, rightSeatRect.width);

    // The three zones share one card size, so whichever already holds cards
    // says how tall a full one really is — an empty zone's min-height alone
    // would understate it and let a later, taller play land somewhere already
    // spoken for.
    const zoneHeight = Math.max(
      plays.left.getBoundingClientRect().height,
      plays.right.getBoundingClientRect().height,
      plays.self.getBoundingClientRect().height,
    );

    // Anchored to the felt's own bottom edge, which is exactly where the hand's
    // row begins (a separate grid row, not a sibling sharing the felt's box) —
    // so this can never reach the hand no matter how short the felt gets.
    const selfTop = dockTop - FELT_GAP - zoneHeight;
    plays.self.style.top = `${selfTop + zoneHeight / 2}px`;
    // Never as wide as the seat columns either, so a long aeroplane can't
    // reach sideways into a seat regardless of how the two overlap vertically.
    fitRow(plays.self, feltRect.width - 2 * (seatWidth + FELT_GAP * 2));

    const belowRoom = selfTop - FELT_GAP - (seatBottom + FELT_GAP);
    const beside = belowRoom < zoneHeight;
    const edgeSafeWidth = 2 * Math.min(SIDE_FRAC, 1 - SIDE_FRAC) * feltRect.width - FELT_GAP * 2;
    for (const [side, seatRect] of [['left', leftSeatRect], ['right', rightSeatRect]]) {
      const zone = plays[side];
      zone.classList.toggle('play--beside', beside);
      if (!beside) {
        zone.style.top = `${seatBottom + FELT_GAP + zoneHeight / 2}px`;
        zone.style.removeProperty('--side-offset');
        fitRow(zone, edgeSafeWidth);
      } else {
        // Vertically centred on the seat it belongs to, but never low enough
        // to reach the self zone's own lane above the hand.
        const seatCenter = (seatRect.top + seatRect.bottom) / 2 - feltRect.top;
        const minCenter = FELT_GAP + zoneHeight / 2;
        const maxCenter = selfTop - FELT_GAP - zoneHeight / 2;
        zone.style.top = `${Math.min(maxCenter, Math.max(minCenter, seatCenter))}px`;
        const offset = FELT_GAP + (side === 'left' ? seatRect.right - feltRect.left : feltRect.right - seatRect.left);
        zone.style.setProperty('--side-offset', `${offset}px`);
        // From the seat's edge to whichever comes first, the felt's own centre
        // or the landlord's three (also centred) — so the two sides can never
        // grow wide enough to meet in the middle or reach the bottom cards.
        const feltCenterX = feltRect.left + feltRect.width / 2;
        const boundary = side === 'left'
          ? Math.min(feltCenterX, bottomCardsRect.left)
          : Math.max(feltCenterX, bottomCardsRect.right);
        const available = side === 'left' ? boundary - seatRect.right : seatRect.left - boundary;
        fitRow(zone, available - FELT_GAP * 2);
      }
    }
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
    ].join('|');
    if (signature === this.handSignature) return;
    this.handSignature = signature;

    const inner = this.nodes.handInner;
    this.nodes.hand.classList.toggle('is-stuck', !!this.stuck);
    clear(inner);
    const width = this.cardWidth();
    const available = Math.max(240, this.root.clientWidth - 40);
    const step = hand.length > 1
      ? Math.min(width * 0.62, (available - width) / (hand.length - 1))
      : 0;
    inner.style.width = `${width + step * Math.max(0, hand.length - 1)}px`;
    inner.style.setProperty('--step', `${step}px`);

    hand.forEach((card, index) => {
      const node = cardElement(card, { selectable: true });
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
    const vw = this.root.clientWidth || 1024;
    return Math.min(82, Math.max(44, vw * 0.074));
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
    const yours = this.isYourPlayTurn();
    const cards = this.selectionCards();
    const combo = cards.length ? classify(cards) : null;
    const current = view.trick?.combo ?? null;
    const legal = !!combo && beats(combo, current);

    n.role.textContent = view.landlord < 0
      ? 'Bidding'
      : view.you.role === 'landlord' ? 'You are the landlord' : 'You are a farmer';
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
    this.dealer?.remove();
    this.dealer = null;
    globalThis.removeEventListener?.('resize', this.onResize);
    clear(this.root);
  }
}

/**
 * Compress a card row's overlap so it never grows wider than `available` px —
 * the hand's fan solves the same problem (N cards, a fixed lane) by shrinking
 * its step instead of its cards; this shrinks the same -0.5 overlap margin
 * the same way, only ever pulling cards tighter than their default overlap,
 * never spreading them further apart than it.
 */
function fitRow(zone, available) {
  const cards = zone.querySelectorAll('.play__cards .card');
  if (cards.length < 2) return;
  const width = cards[0].getBoundingClientRect().width;
  const defaultStep = width * 0.5;
  const step = Math.max(1, Math.min(defaultStep, (available - width) / (cards.length - 1)));
  for (let i = 1; i < cards.length; i++) cards[i].style.marginLeft = `${step - width}px`;
}
