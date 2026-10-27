/**
 * The online Malaysian Blackjack (Ban Luck) table. The server owns the hand;
 * this view only paints what VIEW frames say and reports taps through handlers.
 * It reuses the solo Malaysian table's DOM classes (blackjack.css) so the two
 * read alike: banker box on top, four seat boxes below.
 *
 * Seat numbers here are room seats: 0 is the banker box, 1-4 the player seats.
 */

import { currencyLabel, formatMoney } from '../core/currency.js';
import { chipDenominations } from '../games/blackjack/tables.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el } from './dom.js';
import { enableTableFullscreen } from './fullscreen.js';

// The banker opens hands one at a time; give the last flip a moment to land
// before the sheet covers the felt.
const RESULT_DELAY_MS = 1200;
const ERROR_MS = 4_000;
const NOTE_MS = 3_000;

const RESULT_LABELS = {
  win: 'Win',
  lose: 'Lose',
  push: 'Push',
  run: 'Run',
  banban: 'Ban Ban',
  banluck: 'Ban Luck',
  777: '777',
  'five-dragon': 'Five Dragon',
  out: 'Sat out',
};

/** A seat's tag once its hand is opened. A bust says so rather than just "Lose". */
function seatResultLabel(p) {
  if (p.busted) return p.result === 'push' ? 'Bust — push' : 'Bust';
  if (p.result === 'run') return 'Run — push';
  return RESULT_LABELS[p.result] ?? '';
}

/** A hand read the way it would be said at the table. Empty while it is hidden. */
function handLabel(p) {
  if (p.total == null) return '';
  if (p.result === '777') return '777';
  if (p.result === 'five-dragon') return 'Five Dragon';
  if (p.special === 'banluck') return 'Ban Luck';
  if (p.special === 'banban') return 'Ban Ban';
  return p.busted || p.total > 21 ? `Bust ${p.total}` : `${p.total}`;
}

function createBox({ button = false } = {}) {
  const nameEl = el('span.bj-box__name', '');
  const betEl = el('span.bj-box__bet', '');
  const cardsHost = el('div.bj-box__cards');
  const totalEl = el('span.bj-box__total', '');
  const resultEl = el('div.bj-box__result', '');
  const row = el('div.bj-box__row', nameEl, betEl);
  const box = button
    ? el('button.bj-box', { type: 'button', disabled: true }, row, cardsHost, totalEl, resultEl)
    : el('div.bj-box', row, cardsHost, totalEl, resultEl);
  return { box, nameEl, betEl, cardsHost, totalEl, resultEl, sig: null, shown: 0 };
}

/**
 * "Your bet" with − / amount / + stepping through the table's chip values.
 * Shared by the result card and the room lobby. The amount shown is the
 * caller's `value` until the player steps it, so a figure the server clamped
 * between steps is not rewritten on sight.
 */
export function createBetStepper({ min, max, value, money, onChange }) {
  const steps = chipDenominations({ min, max });
  let current = Math.min(max, Math.max(min, Number(value) || min));
  const valueEl = el('b.bj-bet-step__value', '');
  const move = (dir) => {
    const next = dir < 0 ? [...steps].reverse().find((v) => v < current) : steps.find((v) => v > current);
    if (next == null) return;
    current = next;
    sync();
    onChange?.(next);
  };
  const down = el('button.btn.bj-bet-step__btn', { type: 'button', 'aria-label': 'Lower bet', onclick: () => move(-1) }, '−');
  const up = el('button.btn.bj-bet-step__btn', { type: 'button', 'aria-label': 'Raise bet', onclick: () => move(1) }, '+');
  function sync() {
    valueEl.textContent = money(current);
    down.disabled = current <= steps[0];
    up.disabled = current >= steps[steps.length - 1];
  }
  sync();
  const row = el('div.bj-bet-row',
    el('span.bj-bet-row__label', 'Your bet'),
    el('div.bj-bet-step', { role: 'group', 'aria-label': 'Your bet' }, down, valueEl, up),
  );
  // The host may clamp a step (to the player's chips, say); the caller feeds
  // the bet it actually holds back in so the display never keeps a stale one.
  row.setValue = (next) => {
    const n = Number(next);
    if (!Number.isFinite(n)) return;
    current = Math.min(max, Math.max(min, n));
    sync();
  };
  return row;
}

export class BjOnlineView {
  /**
   * @param {{root: HTMLElement,
   *   meta: {lobbyName: string, currency: string, bankroll: number},
   *   handlers: {onRun?: Function, onHit?: Function, onStand?: Function, onOpen?: Function,
   *     onBet?: Function, onLeave?: Function}}} options
   */
  constructor({ root, meta, handlers }) {
    this.root = root;
    this.meta = { ...meta };
    this.handlers = handlers ?? {};
    this.view = null;
    this.painted = false;
    this.flashTimer = null;
    this.resultTimer = null;
    this.betStepper = null;
    this.teardownFullscreen = null;
    this.nodes = {};
    installCardDefs();
    this.build();
  }

  money(value, compact = false) {
    return formatMoney(Number(value), this.meta.currency, compact);
  }

  build() {
    const n = this.nodes;
    clear(this.root);

    n.leaveBtn = el('button.back-link', { type: 'button', 'aria-label': 'Leave table', onclick: () => this.handlers.onLeave?.() }, '←');
    n.bankPill = el('span.bj-hud__pill', el('small', this.meta.currency ? currencyLabel(this.meta.currency) : 'Chips'), el('b', this.money(this.meta.bankroll)));
    n.limitsPill = el('span.bj-hud__pill', el('small', 'Bets'), el('b', '—'));
    const hud = el('div.bj-hud',
      n.leaveBtn,
      el('span.bj-hud__title', `${this.meta.lobbyName} · Ban Luck`),
      el('div.bj-hud__spacer'),
      n.limitsPill, n.bankPill,
    );

    n.banker = createBox();
    n.seats = [1, 2, 3, 4].map((roomSeat) => {
      const box = createBox({ button: true });
      box.box.addEventListener('click', () => {
        if (box.box.classList.contains('is-openable')) this.handlers.onOpen?.(roomSeat);
      });
      return box;
    });
    n.mtable = el('div.bj-mtable', n.banker.box, el('div.bj-seatrow', ...n.seats.map((s) => s.box)));
    n.shoeIcon = el('div.bj-shoe', cardElement(null, { faceDown: true }));
    n.felt = el('div.bj-felt', n.shoeIcon, n.mtable);

    // Persistent buttons that update() shows or hides: rebuilding them on every
    // frame could eat a tap that straddles one.
    n.runBtn = el('button.btn', { type: 'button', onclick: () => this.handlers.onRun?.() }, 'Run');
    n.hitBtn = el('button.btn.btn--primary', { type: 'button', onclick: () => this.handlers.onHit?.() }, 'Hit');
    n.standBtn = el('button.btn', { type: 'button', onclick: () => this.handlers.onStand?.() }, 'Stand');
    // lan.js writes refusals and reconnect notices here.
    n.comboLabel = el('span.bj-actions__label', '');
    n.actions = el('div.bj-actions', n.runBtn, n.hitBtn, n.standBtn, n.comboLabel);
    for (const b of [n.runBtn, n.hitBtn, n.standBtn]) b.style.display = 'none';

    n.table = el('div.bj-table', hud, n.felt, n.actions);
    this.root.append(
      n.table,
      el('div.bj-rotate-gate',
        el('div',
          el('div.bj-rotate-gate__icon', '↻'),
          el('h2', 'Turn your device'),
          el('p', 'The table is dealt across. Landscape gives every seat room to breathe.'),
        ),
      ),
    );
    this.teardownFullscreen?.();
    this.teardownFullscreen = enableTableFullscreen(n.table, hud);
  }

  animationsOn() {
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  setBankroll(value) {
    this.meta.bankroll = value;
    this.nodes.bankPill.querySelector('b').textContent = this.money(value);
  }

  update(view) {
    this.view = view;
    const n = this.nodes;
    const limits = view.limits;
    if (limits) n.limitsPill.querySelector('b').textContent = `${this.money(limits.min, true)}–${this.money(limits.max, true)}`;
    this.paintBanker(view);
    (view.seats ?? []).slice(0, 4).forEach((s, i) => this.paintSeat(i, s ?? null, view));
    for (let i = (view.seats ?? []).length; i < 4; i += 1) this.paintSeat(i, null, view);
    this.paintActions(view);
    this.painted = true;
    this.paintStatus();
  }

  /** Rebuild a box's cards only when they changed, so a card still mid-entry is not restarted. */
  paintCards(n, cards) {
    const sig = cards.map((c) => (c ? c.id : 'x')).join(',');
    if (sig === n.sig) return;
    const animate = this.painted && this.animationsOn();
    const before = n.shown;
    clear(n.cardsHost);
    cards.forEach((card, i) => {
      const node = cardElement(card ?? null);
      if (animate && i >= before) node.classList.add('bj-card-enter');
      n.cardsHost.append(node);
    });
    n.sig = sig;
    n.shown = cards.length;
  }

  paintBanker(view) {
    const n = this.nodes.banker;
    const banker = view.banker ?? { cards: [] };
    n.box.classList.toggle('bj-box--you', view.seat === 0);
    n.box.classList.toggle('is-active', view.phase === 'banker' || (view.phase !== 'settled' && view.activeSeat === 0));
    n.nameEl.textContent = view.seat === 0 ? 'You' : String(banker.name || 'Banker');
    n.betEl.textContent = 'Banker';
    this.paintCards(n, banker.cards ?? []);
    n.totalEl.textContent = handLabel({ ...banker, busted: banker.total > 21 });
  }

  paintSeat(i, s, view) {
    const n = this.nodes.seats[i];
    const roomSeat = i + 1;
    if (!s) {
      this.paintCards(n, []);
      n.nameEl.textContent = `Seat ${roomSeat}`;
      n.betEl.textContent = '';
      n.totalEl.textContent = '';
      clear(n.resultEl);
      n.resultEl.className = 'bj-box__result';
      n.box.disabled = true;
      n.box.classList.remove('bj-box--you', 'is-active', 'is-openable');
      n.box.classList.add('bj-box--empty');
      return;
    }
    const openable = !!view.you?.openable?.includes(roomSeat);
    n.box.classList.remove('bj-box--empty');
    n.box.classList.toggle('bj-box--you', view.seat === roomSeat);
    n.box.classList.toggle('is-active', view.phase === 'players' && view.activeSeat === roomSeat);
    n.box.classList.toggle('is-openable', openable);
    n.box.disabled = !openable;
    n.nameEl.textContent = view.seat === roomSeat ? 'You' : String(s.name ?? '');
    n.betEl.textContent = typeof s.bet === 'number' ? this.money(s.bet, true) : '';
    this.paintCards(n, s.cards ?? []);
    n.totalEl.textContent = handLabel(s);
    clear(n.resultEl);
    n.resultEl.className = 'bj-box__result';
    if (openable) {
      n.resultEl.append(el('span.bj-box__open', 'Open'));
    } else if (s.result) {
      const payout = Number(s.payout) || 0;
      n.resultEl.className = `bj-box__result ${payout > 0 ? 'is-win' : payout < 0 ? 'is-lose' : 'is-push'}`;
      n.resultEl.textContent = `${seatResultLabel(s)} ${payout >= 0 ? '+' : '−'}${this.money(Math.abs(payout), true)}`;
    }
  }

  paintActions(view) {
    const n = this.nodes;
    const you = view.you ?? {};
    const myTurn = view.phase === 'players' && view.seat >= 1 && view.activeSeat === view.seat;
    const bankerActing = view.phase === 'banker' && view.seat === 0;
    const show = (node, on) => { node.style.display = on ? '' : 'none'; };
    show(n.runBtn, myTurn && !!you.canRun);
    show(n.hitBtn, myTurn || (bankerActing && !!you.canBankerHit));
    show(n.standBtn, myTurn);
    n.hitBtn.disabled = myTurn ? !you.canHit : !you.canBankerHit;
    n.standBtn.disabled = !you.canStand;
  }

  /** The caption saying who is acting, restored after any flash. */
  paintStatus() {
    clearTimeout(this.flashTimer);
    const view = this.view;
    const label = this.nodes.comboLabel;
    label.classList.remove('is-error');
    if (!view) {
      label.textContent = '';
      return;
    }
    const you = view.you ?? {};
    let text;
    if (view.phase === 'settled') text = 'Waiting for the next deal';
    else if (view.phase === 'banker') {
      if (view.seat === 0) text = you.openable?.length ? 'Open a hand, or hit to draw' : 'Hit to draw, or wait for a hand to open';
      else text = 'The banker is opening hands';
    } else if (view.seat >= 1 && view.activeSeat === view.seat) text = 'Your turn';
    else {
      const acting = (view.seats ?? [])[view.activeSeat - 1];
      text = acting?.name ? `${acting.name} is playing` : 'Waiting for the next deal';
    }
    label.textContent = text;
  }

  flash(text, ms, isError) {
    clearTimeout(this.flashTimer);
    if (!text) {
      this.paintStatus();
      return;
    }
    const label = this.nodes.comboLabel;
    label.textContent = text;
    label.classList.toggle('is-error', isError);
    this.flashTimer = setTimeout(() => this.paintStatus(), ms);
  }

  flashError(text) {
    this.flash(String(text ?? ''), ERROR_MS, true);
  }

  /** Table-wide notice (a player left or came back). */
  caption(text) {
    const line = String(text ?? '');
    this.flash(line, NOTE_MS, false);
    if (line) announce(line);
  }

  /**
   * Result card: every seat's outcome and chip change.
   * rows: [{ name, isBanker, result, delta, isMine }]; betControl: { min, max, value }.
   */
  showResult({ title, win, deltaText, rows, lines, betControl, onAgain, againLabel, extraLabel, onExtra, onLeave, immediate = false }) {
    const signed = (delta) => `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${this.money(Math.abs(delta))}`;
    const rowsEl = el('div.b2-result__rows',
      ...rows.map((r) => el('div', { class: `b2-result__row${r.isMine ? ' is-winner' : ''}` },
        el('span.b2-result__name', String(r.name ?? '')),
        el('span.bj-result__tag', r.isBanker ? 'Banker' : (RESULT_LABELS[r.result] ?? '')),
        el('span', { class: `b2-result__delta ${r.delta > 0 ? 'is-win' : r.delta < 0 ? 'is-loss' : ''}` }, signed(r.delta)),
      )),
    );
    // win === null is a hand the viewer sat out: neither colour applies.
    const tone = win === null ? '' : win ? 'is-win' : 'is-loss';
    const head = el('div.b2-result__head',
      el('h2', { class: `b2-result__title ${tone}` }, title),
      el('div', { class: `b2-result__big-delta ${tone}` }, deltaText),
    );
    const bet = betControl
      ? createBetStepper({ ...betControl, money: (v) => this.money(v), onChange: (amount) => this.handlers.onBet?.(amount) })
      : null;
    this.betStepper = bet;
    const nextBtn = el('button.btn.btn--primary', { type: 'button', onclick: (e) => { e.stopPropagation(); overlay.remove(); onAgain?.(); } }, againLabel);
    const extraBtn = extraLabel && onExtra
      ? el('button.btn', { type: 'button', onclick: (e) => { e.stopPropagation(); overlay.remove(); onExtra(); } }, extraLabel)
      : null;
    const leaveBtn = el('button.btn', { type: 'button', onclick: (e) => { e.stopPropagation(); overlay.remove(); onLeave?.(); } }, 'Leave');
    // Same collapse as Big Two's sheet: the opened hands sit under it, so a
    // phone can fold it to a slim bar and read the felt.
    const toggleBtn = el('button.b2-result__toggle', {
      type: 'button',
      onclick: (e) => { e.stopPropagation(); setCollapsed(!overlay.classList.contains('is-collapsed')); },
    }, 'Show table');
    const card = el('div.b2-result',
      head,
      rowsEl,
      el('ul.b2-result__lines', ...(lines ?? []).map((line) => el('li', { html: line }))),
      bet,
      el('div.btn-row', { style: 'justify-content:center' }, nextBtn, extraBtn, leaveBtn),
      toggleBtn,
    );
    const overlay = el('div.b2-overlay', card);
    function setCollapsed(collapsed) {
      overlay.classList.toggle('is-collapsed', collapsed);
      toggleBtn.textContent = collapsed ? 'Show result' : 'Show table';
    }
    card.addEventListener('click', () => { if (overlay.classList.contains('is-collapsed')) setCollapsed(false); });
    this.root.append(overlay);
    clearTimeout(this.resultTimer);
    if (!immediate) {
      overlay.classList.add('is-pending');
      this.resultTimer = setTimeout(() => overlay.classList.remove('is-pending'), RESULT_DELAY_MS);
    }
    return overlay;
  }

  /** The bet the host holds for me, pushed into the result sheet's stepper if one is up. */
  setBet(value) {
    this.betStepper?.setValue(value);
  }

  destroy() {
    this.betStepper = null;
    clearTimeout(this.resultTimer);
    clearTimeout(this.flashTimer);
    this.teardownFullscreen?.();
    this.teardownFullscreen = null;
    clear(this.root);
  }
}
