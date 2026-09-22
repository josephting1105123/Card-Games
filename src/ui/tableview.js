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
import { beats, classify, describeCombo } from '../games/doudizhu/rules.js';
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

    n.hudTurn = el('span.hud__pill', el('small', 'On turn'), el('b', { id: 'hud-turn' }, '—'));
    n.hudMult = el('span.hud__pill', el('small', 'Multiplier'), el('b', '×2'));
    n.hudPot = el('span.hud__pill', el('small', 'Pot'), el('b', this.meta.potLabel));
    // The pill already names the coin, so the amount does not repeat it.
    n.hudPurse = el('span.hud__pill', { style: `--pill-tint:${currencyTint(this.currency)}` },
      el('small', currencyLabel(this.currency)),
      el('b', formatAmount(this.meta.bankroll ?? 0)));

    const hud = el('div.hud',
      el('button.back-link', { type: 'button', onclick: () => this.handlers.onLeave?.() }, '← Leave table'),
      el('span.hud__pill', el('small', 'Table'), el('b', this.meta.lobbyName)),
      el('div.hud__spacer'),
      n.hudTurn, n.hudMult, n.hudPot, n.hudPurse,
    );

    n.leftSeat = this.buildSeat('left');
    n.rightSeat = this.buildSeat('right');
    n.bottomRow = el('div.bottom-cards__row');
    n.bottom = el('div.bottom-cards', el('span.bottom-cards__label', 'Landlord’s three'), n.bottomRow);
    n.trickCards = el('div.trick__cards');
    n.trickLabel = el('div.trick__label.is-muted', 'Waiting');
    n.trick = el('div.trick', n.trickCards, n.trickLabel);
    n.bidPanel = el('div.bid-panel', { hidden: true });
    n.felt = el('div.felt', n.leftSeat.wrap, n.rightSeat.wrap, n.bottom, n.trick, n.bidPanel);

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
    if (previous && previous.plays?.length !== view.plays?.length) this.hinted.clear();

    this.renderSeats();
    this.renderBottom();
    this.renderTrick();
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

  seatNodeFor(seat) {
    const view = this.view;
    if (!view) return null;
    const left = (view.seat + 1) % 3;
    if (seat === left) return this.nodes.leftSeat;
    if (seat === (view.seat + 2) % 3) return this.nodes.rightSeat;
    return null;
  }

  renderHud() {
    const view = this.view;
    const onTurn = view.phase === Phase.BIDDING ? view.bidding.turn : view.turn;
    const label = onTurn === view.seat ? 'You' : (view.players[onTurn]?.name ?? '—');
    this.nodes.hudTurn.querySelector('b').textContent = view.phase === Phase.FINISHED ? 'Over' : label;
    const mult = this.nodes.hudMult.querySelector('b');
    const shown = Math.max(view.multiplier, this.meta.baseMultiplier ?? 1);
    mult.textContent = `×${shown}`;
    this.nodes.hudMult.classList.toggle('is-hot', shown > (this.meta.baseMultiplier ?? 1) * 2);
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

  renderTrick() {
    const view = this.view;
    this.nodes.trick.hidden = view.phase === Phase.BIDDING;
    clear(this.nodes.trickCards);
    if (!view.trick) {
      this.nodes.trickLabel.textContent = view.phase === Phase.PLAYING
        ? (view.turn === view.seat ? 'Your lead' : 'Fresh trick')
        : 'Waiting';
      this.nodes.trickLabel.classList.add('is-muted');
      return;
    }
    for (const card of sortCards(view.trick.cards)) this.nodes.trickCards.append(cardElement(card));
    const who = view.trick.leader === view.seat ? 'You' : view.players[view.trick.leader].name;
    this.nodes.trickLabel.textContent = `${who}: ${describeCombo(view.trick.combo)}`;
    this.nodes.trickLabel.classList.remove('is-muted');
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
