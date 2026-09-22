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
import { findHint } from '../games/doudizhu/moves.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el } from './dom.js';

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

    this.root.append(
      el('div.table', hud, n.felt, n.dock),
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
      clear(node.backs);
      const shown = Math.min(player.cards, 12);
      for (let i = 0; i < shown; i++) node.backs.append(cardElement(null, { faceDown: true }));
    }
  }

  renderBottom() {
    const view = this.view;
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

  renderBidding() {
    const view = this.view;
    const panel = this.nodes.bidPanel;
    if (view.phase !== Phase.BIDDING) {
      panel.hidden = true;
      return;
    }
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
    const inner = this.nodes.handInner;
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
    if (!this.isYourPlayTurn()) return;
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
    n.playBtn.disabled = !yours || !legal;
    n.passBtn.disabled = !yours || !current;
    n.hintBtn.disabled = !yours;
    n.comboLabel.textContent = !cards.length
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
    clear(this.root);
  }
}

/** "Pair", "Straight ×5" — short enough to sit under a play without shouting. */
function shortName(combo) {
  if (!combo) return '';
  const name = comboName(combo.type);
  return combo.length > 1 ? `${name} ×${combo.length}` : name;
}
