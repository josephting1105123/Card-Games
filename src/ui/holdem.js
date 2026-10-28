/**
 * Texas Hold'em table: you and five bots, one hand after another.
 *
 * Two classes with a hard line between them. HoldemGame owns the match (the
 * engine state, the bots, the bankroll) and HoldemView only draws what a
 * seatView says, so an online client can feed the same view later without it
 * ever seeing an engine state object.
 *
 * The engine deals a whole street the moment the betting closes, and the whole
 * board at once on an all-in runout. The pacing lives here instead: the
 * controller tells the view how many board cards to show (`boardCount`) and
 * walks that number up a street at a time, which is what makes the action that
 * closed a street stay on screen until the new cards arrive.
 */

import { formatMoney } from '../core/currency.js';
import { formatChips } from '../core/economy.js';
import { makeRng, randomSeed } from '../core/rng.js';
import { recordBlackjackResult } from '../games/blackjack/stats.js';
import { skillByName } from '../games/holdem/ai.js';
import { Phase, act, createHand, nextButton, seatView } from '../games/holdem/engine.js';
import { botTurn } from '../games/holdem/match.js';
import { bestHand, pokerRank } from '../games/holdem/rules.js';
import { MAX_BUYIN_BB, buyIn, minBuyIn } from '../games/holdem/tables.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el, wait } from './dom.js';
import { enableTableFullscreen } from './fullscreen.js';

const CAPTION_MS = 2600;
// The reveal gets a second on its own before the result bar takes the dock.
const RESULT_DELAY_MS = 1000;
const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui', 'Qiao', 'Rong', 'Wen', 'Jun'];
const BOLD = { style: 'bold' };
// Clockwise from the player at the bottom: bottom-left, top-left, top, top-right, bottom-right.
const SLOTS = ['self', 'bl', 'tl', 'top', 'tr', 'br'];
const BOARD_SIZE = 5;

const RANK_WORD = {
  2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
  9: 'nine', 10: 'ten', 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace',
};
const RANK_PLURAL = {
  2: 'twos', 3: 'threes', 4: 'fours', 5: 'fives', 6: 'sixes', 7: 'sevens', 8: 'eights',
  9: 'nines', 10: 'tens', 11: 'jacks', 12: 'queens', 13: 'kings', 14: 'aces',
};

const fmt = (value) => formatChips(value);
const fmtShort = (value) => formatChips(value, true);

/** The street a given number of board cards belongs to. */
function streetOf(count) {
  if (count >= 5) return 'river';
  if (count === 4) return 'turn';
  if (count === 3) return 'flop';
  return 'preflop';
}

/** What two hole cards are worth before any board: "Pair of nines", "Ace-king suited". */
function describeHole(hole) {
  if (hole.length < 2) return '';
  const [a, b] = [...hole].sort((x, y) => pokerRank(y) - pokerRank(x));
  const ra = pokerRank(a);
  const rb = pokerRank(b);
  if (ra === rb) return `Pair of ${RANK_PLURAL[ra]}`;
  const high = RANK_WORD[ra];
  return `${high[0].toUpperCase()}${high.slice(1)}-${RANK_WORD[rb]} ${a.suit === b.suit ? 'suited' : 'offsuit'}`;
}

function actionText(entry, short = fmtShort) {
  if (entry.allIn && entry.action !== 'fold' && entry.action !== 'check') return `All-in ${short(entry.to)}`;
  switch (entry.action) {
    case 'fold': return 'Fold';
    case 'check': return 'Check';
    case 'call': return `Call ${short(entry.amount)}`;
    case 'bet': return `Bet ${short(entry.to)}`;
    case 'raise': return `Raise to ${short(entry.to)}`;
    default: return '';
  }
}

export class HoldemGame {
  /**
   * @param {object} app the app context from main.js
   * @param {{table: object}} options
   */
  constructor(app, { table }) {
    this.app = app;
    this.table = table;
    this.stopped = false;
    this.pumping = false;
    this.settled = true;
    this.state = null;
    this.shown = 0;
    this.button = -1;
  }

  mount(root) {
    const profile = this.app.profile;
    this.root = root;
    if (profile.bankroll < minBuyIn(this.table)) {
      this.app.replace('lobby', { gameId: 'texas' });
      return;
    }
    this.skill = skillByName(this.table.skill);
    this.tableRng = makeRng(`${randomSeed()}:table`);
    this.seats = [{ name: profile.name || 'You', isHuman: true, isBot: false, stack: buyIn(this.table, profile.bankroll) }];
    for (let i = 1; i < 6; i++) this.seats.push(this.newBot());

    this.view = new HoldemView({
      root,
      meta: {
        tableName: this.table.name,
        blinds: `${fmtShort(this.table.sb)}/${fmtShort(this.table.bb)}`,
        bankroll: profile.bankroll,
        animations: profile.settings?.animations !== false,
      },
      handlers: {
        onAction: (action) => this.onAction(action),
        onLeave: () => this.leave(),
      },
    });
    this.newHand();
  }

  unmount() {
    // Leaving by any route, Back included, costs the chips already in the pot.
    this.forfeit();
    this.stopped = true;
    this.view?.destroy();
  }

  leave() {
    this.app.go('lobby', { gameId: 'texas' });
  }

  newBot() {
    const taken = new Set(this.seats.map((s) => s.name));
    const pool = BOT_NAMES.filter((name) => !taken.has(name));
    const name = pool[Math.floor(this.tableRng() * pool.length)];
    return { name, isHuman: false, isBot: true, skill: this.skill, stack: this.table.bb * MAX_BUYIN_BB };
  }

  newHand() {
    if (this.stopped || this.seats[0].stack <= 0) return;
    const seated = [];
    for (let i = 1; i < this.seats.length; i++) {
      if (this.seats[i].stack > 0) continue;
      this.seats[i] = this.newBot();
      seated.push(this.seats[i].name);
    }
    this.button = this.button < 0
      ? Math.floor(this.tableRng() * this.seats.length)
      : nextButton(this.seats, this.button);
    this.seed = randomSeed();
    this.rng = makeRng(`${this.seed}:bots`);
    this.state = createHand({
      seed: this.seed,
      players: this.seats,
      button: this.button,
      smallBlind: this.table.sb,
      bigBlind: this.table.bb,
    });
    this.settled = false;
    this.shown = 0;
    this.view.newHand();
    if (seated.length) this.view.caption(`${seated.join(' and ')} ${seated.length === 1 ? 'sits' : 'sit'} down`);
    this.pump();
  }

  get animated() {
    return this.app.profile.settings?.animations !== false;
  }

  pause(ms) {
    return wait(this.animated ? ms : 60);
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.loop();
    } finally {
      this.pumping = false;
    }
  }

  /** Let the bots act, reveal streets, and stop on the human's turn or the end of the hand. */
  async loop() {
    const st = this.state;
    for (;;) {
      if (this.stopped) return;
      await this.syncBoard();
      if (this.stopped) return;
      if (st.phase === Phase.FINISHED) {
        await this.finishHand();
        return;
      }
      if (st.turn === 0) {
        this.view.update(seatView(st, 0), { boardCount: this.shown, controls: true });
        return;
      }
      // With nothing of yours left to play the hand speeds up.
      const out = st.players[0].folded || st.players[0].allIn;
      await this.pause(out ? 250 + this.rng() * 200 : 600 + this.rng() * 400);
      if (this.stopped) return;
      if (!botTurn(st, this.rng)) {
        // Nobody can act yet the hand is not over: show what there is rather than hang.
        this.view.update(seatView(st, 0), { boardCount: this.shown, controls: false });
        return;
      }
    }
  }

  /**
   * Show the latest action on the street it happened, then walk the board up to
   * what the engine dealt: flop together, then a card at a time. An all-in
   * runout gets the longer beat between streets.
   */
  async syncBoard() {
    const st = this.state;
    const sv = seatView(st, 0);
    const target = st.board.length;
    this.view.update(sv, { boardCount: this.shown, controls: false });
    if (target <= this.shown) return;
    await this.pause(450);
    while (this.shown < target && !this.stopped) {
      this.shown = this.shown < 3 ? Math.min(3, target) : this.shown + 1;
      this.view.update(sv, { boardCount: this.shown, controls: false });
      await this.pause(this.shown < target ? 700 : 500);
    }
  }

  onAction(action) {
    if (this.stopped || this.pumping || !this.state || this.state.turn !== 0) return;
    const res = act(this.state, 0, action);
    if (!res.ok) {
      announce(res.error);
      this.view.flashError(res.error);
      return;
    }
    this.pump();
  }

  async finishHand() {
    const st = this.state;
    const res = st.result;
    for (let i = 0; i < this.seats.length; i++) this.seats[i].stack = st.players[i].stack;
    const net = res.net[0];
    const sv = seatView(st, 0);
    this.view.update(sv, { boardCount: this.shown, reveal: true, controls: false });
    this.settle(net);
    announce(net > 0 ? `You win ${fmt(net)}` : net < 0 ? `You lose ${fmt(-net)}` : 'You break even');
    await this.pause(RESULT_DELAY_MS);
    if (this.stopped) return;

    const profile = this.app.profile;
    let againLabel = 'Next hand';
    let onAgain = () => this.newHand();
    if (st.players[0].stack <= 0) {
      if (profile.bankroll >= minBuyIn(this.table)) {
        againLabel = `Rebuy (${fmt(buyIn(this.table, profile.bankroll))})`;
        onAgain = () => {
          this.seats[0].stack = buyIn(this.table, this.app.profile.bankroll);
          this.newHand();
        };
      } else {
        againLabel = 'Choose another table';
        onAgain = () => this.leave();
      }
    }
    let handText;
    if (st.players[0].folded) handText = 'You folded';
    else if (res.uncontested) handText = 'Everyone else folded';
    else handText = res.hands[0]?.name ?? '';
    this.view.showResult({ net, handText, againLabel, onAgain, onLeave: () => this.leave() });
  }

  /** Book the hand once: the bankroll follows the stack hand by hand, so leaving loses nothing more. */
  settle(net) {
    if (this.settled) return;
    this.settled = true;
    recordBlackjackResult(this.app.profile, 'texas', net);
    this.app.refreshChrome?.();
    if (!this.stopped) this.view?.setBankroll(this.app.profile.bankroll);
  }

  forfeit() {
    const st = this.state;
    if (!st || this.settled) return;
    if (st.phase === Phase.FINISHED) {
      this.settle(st.result.net[0]);
      return;
    }
    const committed = st.players[0].committed;
    if (committed > 0) this.settle(-committed);
    else this.settled = true;
  }
}

export class HoldemView {
  /**
   * @param {{root: HTMLElement, meta: object, handlers: {onAction: Function, onLeave: Function}}} options
   */
  constructor({ root, meta, handlers }) {
    installCardDefs();
    this.root = root;
    this.meta = meta;
    this.handlers = handlers;
    this.sv = null;
    this.opts = {};
    this.reveal = false;
    this.boardCount = 0;
    this.renderedBoard = 0;
    this.holeSig = '';
    this.legal = null;
    this.legalKey = '';
    this.raiseTo = 0;
    this.controlsOn = false;
    this.seatNodes = [];
    this.build();
    this.onKey = (event) => this.handleKey(event);
    document.addEventListener('keydown', this.onKey);
  }

  /** Money in the room's currency when the host names one; solo play keeps the solo coin. */
  fmt(value) {
    return this.meta.currency ? formatMoney(value, this.meta.currency) : formatChips(value);
  }

  fmtShort(value) {
    return this.meta.currency ? formatMoney(value, this.meta.currency, true) : formatChips(value, true);
  }

  build() {
    clear(this.root);
    const n = this.nodes = {};

    n.potPill = el('span.he-hud__pill', el('small', 'Pot'), el('b', this.fmt(0)));
    n.stackPill = el('span.he-hud__pill', el('small', 'Stack'), el('b', this.fmt(0)));
    // In a room the stack is the room's chips, so a second "Chips" pill would repeat it.
    n.bankPill = el('span.he-hud__pill', { hidden: !!this.meta.currency }, el('small', 'Chips'), el('b', this.fmt(this.meta.bankroll ?? 0)));
    const hud = el('div.he-hud',
      el('button.back-link', { type: 'button', 'aria-label': 'Leave table', title: 'Leave table', onclick: () => this.handlers.onLeave?.() }, '←'),
      el('span.he-hud__pill.he-hud__pill--table', el('b', this.meta.tableName), el('small', `Blinds ${this.meta.blinds}`)),
      el('div.he-hud__spacer'),
      n.potPill, n.stackPill, n.bankPill,
    );

    n.slots = Array.from({ length: BOARD_SIZE }, () => ({ node: el('div.he-slot'), card: null }));
    n.board = el('div.he-board', ...n.slots.map((s) => s.node));
    n.potText = el('div.he-potline', 'Pot 0');
    n.lines = el('div.he-lines', { 'aria-live': 'polite' });
    n.center = el('div.he-center', n.board, n.potText, n.lines);
    n.caption = el('div.he-caption', { 'aria-hidden': 'true' });
    n.layer = el('div.he-seats');
    n.felt = el('div.he-felt', el('div.he-rail'), n.center, n.layer, n.caption);

    n.holeCards = el('div.he-hole');
    n.handLabel = el('small', 'Your hand');
    n.handName = el('b', '—');
    n.hand = el('div.he-hand', n.handLabel, n.handName);

    n.foldBtn = el('button.btn', { type: 'button', onclick: () => this.send({ type: 'fold' }) }, 'Fold');
    n.callBtn = el('button.btn', { type: 'button', onclick: () => this.send(this.legal?.canCheck ? { type: 'check' } : { type: 'call' }) }, 'Check');
    n.raiseBtn = el('button.btn.btn--primary', { type: 'button', onclick: () => this.submitRaise() }, 'Raise');
    n.presetBtns = [
      ['min', 'Min'], ['half', '½ Pot'], ['pot', 'Pot'], ['max', 'All-in'],
    ].map(([kind, label]) => el('button.btn.he-preset', { type: 'button', onclick: () => this.setRaise(this.presetValue(kind)) }, label));
    n.slider = el('input.he-slider', { type: 'range', 'aria-label': 'Raise amount', min: '0', max: '0', step: '1', value: '0', oninput: () => this.onSlide() });
    n.amount = el('b.he-amount', '0');
    n.actRow = el('div.he-row.he-row--act', n.foldBtn, n.callBtn, n.raiseBtn);
    n.sizeRow = el('div.he-row.he-row--size', ...n.presetBtns, n.slider, n.amount);
    n.status = el('div.he-status', { hidden: true });
    n.controls = el('div.he-controls', n.actRow, n.sizeRow, n.status);
    n.result = el('div.he-result', { hidden: true });
    n.dock = el('div.he-dock', n.holeCards, n.hand, n.controls, n.result);

    n.table = el('div.he-table', hud, n.felt, n.dock);
    n.table.addEventListener('scroll', () => { n.table.scrollTop = 0; n.table.scrollLeft = 0; });

    this.root.append(
      n.table,
      el('div.he-rotate-gate',
        el('div',
          el('div.he-rotate-gate__icon', '↻'),
          el('h2', 'Turn your device'),
          el('p', 'Hold’em is played around the table. Landscape gives the seats and the board room to sit.'),
        ),
      ),
    );
    this.teardownFullscreen = enableTableFullscreen(n.table, hud);
  }

  animationsOn() {
    if (this.meta.animations === false) return false;
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  /** Clear everything that belongs to the last hand. */
  newHand() {
    const n = this.nodes;
    this.renderedBoard = 0;
    for (const slot of n.slots) {
      slot.card?.remove();
      slot.card = null;
    }
    this.holeSig = '';
    this.legalKey = '';
    this.sv = null;
    this.reveal = false;
    for (const seat of this.seatNodes) seat.cardsKind = '';
    n.result.hidden = true;
    n.controls.hidden = false;
    clear(n.result);
    clear(n.lines);
  }

  caption(text) {
    clearTimeout(this.captionTimer);
    this.nodes.caption.textContent = text;
    this.nodes.caption.classList.add('is-on');
    this.captionTimer = setTimeout(() => this.nodes.caption.classList.remove('is-on'), CAPTION_MS);
  }

  flashError(message) {
    const n = this.nodes;
    clearTimeout(this.errorTimer);
    n.handName.textContent = message;
    n.handName.classList.add('is-error');
    this.errorTimer = setTimeout(() => {
      n.handName.classList.remove('is-error');
      this.renderHandName();
    }, 1800);
  }

  setBankroll(value) {
    this.meta.bankroll = value;
    this.nodes.bankPill.querySelector('b').textContent = this.fmt(value);
  }

  /**
   * Replace the displayed state.
   * @param {object} sv a seatView
   * @param {{boardCount?: number, reveal?: boolean, controls?: boolean}} [opts]
   *   boardCount how many board cards to show (the engine may already have dealt more),
   *   reveal true once the showdown banners and the final stacks may appear,
   *   controls false while the table is busy animating and it is not yet your move.
   */
  update(sv, opts = {}) {
    this.sv = sv;
    this.opts = opts;
    this.boardCount = Math.min(opts.boardCount ?? sv.board.length, sv.board.length);
    this.reveal = !!opts.reveal && !!sv.result;
    this.winners = this.computeWinners();
    this.ensureSeats();
    this.renderHud();
    this.renderSeats();
    this.renderBoard();
    this.renderCenter();
    this.renderDock();
    this.renderControls();
  }

  /** Who won a pot, and which of their cards made the hand. */
  computeWinners() {
    const out = { seats: new Set(), cards: new Map(), all: new Set() };
    const result = this.sv.result;
    if (!this.reveal) return out;
    for (const pot of result.pots) for (const seat of pot.winners) out.seats.add(seat);
    if (result.showdown) {
      for (const seat of out.seats) {
        const ids = new Set((result.hands[seat]?.cards ?? []).map((c) => c.id));
        out.cards.set(seat, ids);
        for (const id of ids) out.all.add(id);
      }
    }
    return out;
  }

  nameOf(seat) {
    return seat === this.sv.seat ? 'You' : this.sv.players[seat].name;
  }

  /** The stack to draw: the engine has paid the pot out already, the table has not. */
  displayStack(p) {
    if (this.reveal || !this.sv.result) return p.stack;
    return p.stack - (this.sv.result.winnings[p.seat] ?? 0);
  }

  // ---- seats -----------------------------------------------------------------

  slotFor(index) {
    const count = this.sv.players.length;
    return SLOTS[(((index - this.sv.seat) % count) + count) % count % SLOTS.length];
  }

  ensureSeats() {
    const { players } = this.sv;
    if (this.seatNodes.length === players.length && this.seatYou === this.sv.seat) return;
    const n = this.nodes;
    clear(n.layer);
    this.seatYou = this.sv.seat;
    this.seatNodes = players.map((p, index) => {
      const slot = this.slotFor(index);
      const avatar = el('span.he-seat__avatar', { dataset: { tone: String(index % 5) } });
      const name = el('span.he-seat__name');
      const stack = el('span.he-seat__stack');
      const tag = el('span.he-seat__tag');
      // The dealer disc rides on the plate's corner so it moves with the plate, not the cards row.
      const dealer = el('span.he-dealer', { title: 'Dealer', hidden: true }, 'D');
      const plate = el('div.he-seat__plate', avatar, el('span.he-seat__text', name, stack), tag, dealer);
      const cards = el('div.he-seat__cards');
      const bubble = el('span.he-bubble', { hidden: true });
      const wrap = el(`div.he-seat.he-seat--${slot}`, cards, plate, bubble);
      const coin = el('span.he-coin');
      const betAmount = el('span');
      const bet = el(`div.he-bet.he-bet--${slot}`, { hidden: true }, coin, betAmount);
      n.layer.append(wrap, bet);
      return { wrap, avatar, name, stack, tag, plate, cards, dealer, bubble, bet, betAmount, slot, cardsKind: '' };
    });
  }

  lastAction(seat) {
    const street = streetOf(this.boardCount);
    let last = null;
    for (const entry of this.sv.log) {
      if (entry.seat !== seat || entry.street !== street) continue;
      if (entry.action === 'sb' || entry.action === 'bb') continue;
      last = entry;
    }
    return last;
  }

  renderSeats() {
    const { sv } = this;
    const settled = this.boardCount === sv.board.length;
    const finished = sv.phase === Phase.FINISHED;
    sv.players.forEach((p, index) => {
      const seat = this.seatNodes[index];
      const out = p.sittingOut;
      seat.avatar.textContent = (p.name || '?').slice(0, 1).toUpperCase();
      seat.name.textContent = p.name;
      // All-in is a live state; once the pot is paid out every plate shows what is left.
      const stackNow = this.displayStack(p);
      if (this.reveal) seat.stack.textContent = stackNow > 0 ? this.fmtShort(stackNow) : 'Out';
      else seat.stack.textContent = p.allIn && !out ? 'All-in' : this.fmtShort(stackNow);
      seat.wrap.classList.toggle('is-folded', p.folded || out);
      const onTurn = settled && !finished && sv.turn === index;
      seat.wrap.classList.toggle('is-turn', onTurn);
      seat.wrap.classList.toggle('is-winner', this.winners.seats.has(index));

      seat.dealer.hidden = index !== sv.button;
      seat.tag.textContent = index === sv.sbSeat ? 'SB' : index === sv.bbSeat ? 'BB' : '';
      seat.tag.hidden = !seat.tag.textContent;

      // Bubble: "Thinking…" while a bot is deciding, otherwise its latest action this street.
      let text = '';
      let thinking = false;
      if (onTurn && index !== sv.seat) {
        text = 'Thinking…';
        thinking = true;
      } else if (!this.reveal && !out) {
        const last = this.lastAction(index);
        if (last) text = actionText(last, (value) => this.fmtShort(value));
      }
      seat.bubble.textContent = text;
      seat.bubble.hidden = !text;
      seat.bubble.classList.toggle('is-thinking', thinking);

      const bet = this.reveal ? 0 : p.bet;
      seat.betAmount.textContent = this.fmtShort(bet);
      seat.bet.hidden = !(bet > 0);

      this.renderSeatCards(seat, p, index);
    });
  }

  renderSeatCards(seat, p, index) {
    let kind = 'none';
    if (seat.slot !== 'self' && !p.sittingOut && !p.folded) {
      kind = p.hole ? `face:${p.hole.map((c) => c.id).join(',')}` : 'back';
    }
    if (kind !== seat.cardsKind) {
      const wasBack = seat.cardsKind === 'back';
      seat.cardsKind = kind;
      clear(seat.cards);
      if (kind === 'back') {
        seat.cards.append(cardElement(null, BOLD), cardElement(null, BOLD));
      } else if (kind.startsWith('face:')) {
        for (const card of p.hole) {
          const node = cardElement(card, BOLD);
          if (wasBack && this.animationsOn()) node.classList.add('he-flip');
          seat.cards.append(node);
        }
      }
    }
    const mine = this.winners.cards.get(index);
    const decided = this.reveal && this.sv.result.showdown;
    for (const node of seat.cards.children) {
      const id = Number(node.dataset.cardId);
      if (!id && id !== 0) continue;
      node.classList.toggle('is-win', !!mine?.has(id));
      node.classList.toggle('is-dim', decided && !mine?.has(id) && this.winners.seats.size > 0);
    }
  }

  // ---- centre ----------------------------------------------------------------

  renderBoard() {
    const { sv } = this;
    const n = this.nodes;
    const count = this.boardCount;
    const fresh = this.animationsOn();
    const firstNew = this.renderedBoard;
    n.slots.forEach((slot, i) => {
      const card = i < count ? sv.board[i] : null;
      if (!card) {
        slot.card?.remove();
        slot.card = null;
        return;
      }
      if (!slot.card || Number(slot.card.dataset.cardId) !== card.id) {
        slot.card?.remove();
        slot.card = cardElement(card, BOLD);
        if (fresh && i >= firstNew) {
          slot.card.classList.add('he-deal');
          slot.card.style.setProperty('--he-delay', `${(i - firstNew) * 150}ms`);
        }
        slot.node.append(slot.card);
      }
      const decided = this.reveal && sv.result.showdown && this.winners.all.size > 0;
      slot.card.classList.toggle('is-win', this.winners.all.has(card.id));
      slot.card.classList.toggle('is-dim', decided && !this.winners.all.has(card.id));
    });
    this.renderedBoard = count;
  }

  renderCenter() {
    const { sv } = this;
    const n = this.nodes;
    n.potText.textContent = `Pot ${this.fmt(sv.pot)}`;
    n.potText.hidden = this.reveal;
    clear(n.lines);
    if (!this.reveal) return;
    const { result } = sv;
    result.pots.forEach((pot, i) => {
      let text;
      if (result.uncontested) {
        const seat = pot.winners[0];
        text = `${this.nameOf(seat)} ${seat === sv.seat ? 'win' : 'wins'} ${this.fmt(pot.amount)}`;
      } else {
        const label = result.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : `Side pot ${i}`;
        const who = pot.winners.map((seat) => this.nameOf(seat)).join(', ');
        text = `${label}: ${this.fmt(pot.amount)}${pot.winners.length > 1 ? ' split' : ''} — ${who} · ${pot.handName}`;
      }
      n.lines.append(el('div.he-line', text));
    });
    if (result.refund && result.refund.amount > 0) {
      n.lines.append(el('div.he-line.he-line--note', `${this.fmt(result.refund.amount)} returned to ${this.nameOf(result.refund.seat)}`));
    }
  }

  // ---- hud and dock ----------------------------------------------------------

  renderHud() {
    const { sv } = this;
    const n = this.nodes;
    n.potPill.querySelector('b').textContent = this.fmt(sv.pot);
    n.stackPill.querySelector('b').textContent = this.fmt(this.displayStack(sv.players[sv.seat]));
  }

  renderDock() {
    const { sv } = this;
    const n = this.nodes;
    const hole = sv.you.hole;
    const mine = this.winners.cards.get(sv.seat);
    const sig = hole.map((c) => c.id).join(',');
    if (sig !== this.holeSig) {
      this.holeSig = sig;
      clear(n.holeCards);
      hole.forEach((card, i) => {
        const node = cardElement(card, BOLD);
        if (this.animationsOn()) {
          node.classList.add('he-deal');
          node.style.setProperty('--he-delay', `${i * 150}ms`);
        }
        n.holeCards.append(node);
      });
    }
    const decided = this.reveal && sv.result.showdown && this.winners.all.size > 0;
    for (const node of n.holeCards.children) {
      const id = Number(node.dataset.cardId);
      node.classList.toggle('is-win', !!mine?.has(id));
      node.classList.toggle('is-dim', decided && !mine?.has(id));
    }
    n.holeCards.classList.toggle('is-folded', sv.players[sv.seat].folded);
    this.renderHandName();
  }

  renderHandName() {
    const { sv } = this;
    if (!sv || this.nodes.handName.classList.contains('is-error')) return;
    const hole = sv.you.hole;
    let text = '';
    if (sv.players[sv.seat].folded) text = 'Folded';
    else if (this.reveal && sv.result.hands?.[sv.seat]) text = sv.result.hands[sv.seat].name;
    else if (hole.length === 2 && this.boardCount >= 3) text = bestHand([...hole, ...sv.board.slice(0, this.boardCount)]).name;
    else if (hole.length === 2) text = describeHole(hole);
    this.nodes.handName.textContent = text || '—';
  }

  // ---- controls --------------------------------------------------------------

  renderControls() {
    const { sv } = this;
    const n = this.nodes;
    const legal = this.opts.controls === false || this.reveal ? null : sv.legal;
    this.legal = legal;
    const on = !!legal;
    this.controlsOn = on;
    // Nothing to decide while you watch the hand play out: say why instead of showing stale buttons.
    const me0 = sv.players[sv.seat];
    const status = me0.folded ? 'You folded' : me0.allIn ? 'You’re all-in' : '';
    n.status.textContent = status;
    n.status.hidden = !status;
    n.actRow.hidden = !!status;
    n.sizeRow.hidden = !!status;
    if (status) return;
    n.foldBtn.disabled = !on;
    n.callBtn.disabled = !on;
    const canRaise = on && legal.canRaise;
    // Out of your turn the raise controls show greyed; on your turn with no raise left they go.
    const noRaise = on && !legal.canRaise;
    n.sizeRow.classList.toggle('is-off', noRaise);
    n.raiseBtn.classList.toggle('is-off', noRaise);
    for (const button of [...n.presetBtns, n.raiseBtn]) button.disabled = !canRaise;
    n.slider.disabled = !canRaise || legal.minRaiseTo >= legal.maxRaiseTo;
    if (!on) return;

    const me = sv.players[sv.seat];
    n.callBtn.textContent = legal.canCheck
      ? 'Check'
      : `Call ${this.fmt(legal.toCall)}${legal.toCall >= me.stack ? ' (all-in)' : ''}`;
    if (!canRaise) return;
    const key = `${sv.phase}|${sv.currentBet}|${legal.minRaiseTo}|${legal.maxRaiseTo}`;
    if (key !== this.legalKey) {
      this.legalKey = key;
      n.slider.min = String(legal.minRaiseTo);
      n.slider.max = String(legal.maxRaiseTo);
      this.raiseTo = legal.minRaiseTo;
    }
    this.setRaise(this.raiseTo);
  }

  presetValue(kind) {
    const { legal, sv } = this;
    if (!legal) return 0;
    // Pot-sized raise: call first, then raise by what the pot has grown to.
    const potRaise = (fraction) => sv.currentBet + fraction * (sv.pot + legal.toCall);
    switch (kind) {
      case 'min': return legal.minRaiseTo;
      case 'half': return potRaise(0.5);
      case 'pot': return potRaise(1);
      default: return legal.maxRaiseTo;
    }
  }

  setRaise(value) {
    const { legal } = this;
    if (!legal || !legal.canRaise) return;
    const v = Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, value)));
    this.raiseTo = v;
    const n = this.nodes;
    n.slider.value = String(v);
    n.amount.textContent = this.fmt(v);
    n.raiseBtn.textContent = v >= legal.maxRaiseTo
      ? `All-in ${this.fmt(v)}`
      : legal.isBet ? `Bet ${this.fmt(v)}` : `Raise to ${this.fmt(v)}`;
  }

  /** Snap the slider to whole big blinds above the minimum, but never short of the all-in. */
  onSlide() {
    const { legal, sv } = this;
    if (!legal) return;
    const step = sv.bigBlind;
    let v = Number(this.nodes.slider.value);
    v = legal.minRaiseTo + Math.round((v - legal.minRaiseTo) / step) * step;
    if (legal.maxRaiseTo - v <= step / 2) v = legal.maxRaiseTo;
    this.setRaise(v);
  }

  submitRaise() {
    const { legal } = this;
    if (!legal || !legal.canRaise) return;
    const to = this.raiseTo;
    this.send(to >= legal.maxRaiseTo ? { type: 'allin' } : { type: legal.isBet ? 'bet' : 'raise', amount: to });
  }

  send(action) {
    if (!this.controlsOn) return;
    this.handlers.onAction?.(action);
  }

  handleKey(event) {
    if (!this.controlsOn || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || (target.tagName === 'INPUT' && target.type !== 'range'))) return;
    const key = event.key.toLowerCase();
    if (key === 'f') this.send({ type: 'fold' });
    else if (key === 'c') this.send(this.legal?.canCheck ? { type: 'check' } : { type: 'call' });
    else if (key === 'r') this.submitRaise();
    else return;
    event.preventDefault();
  }

  // ---- result ----------------------------------------------------------------

  /** A slim bar in the dock where the controls were, so the felt stays uncovered. */
  showResult({ net, handText, againLabel, onAgain, onLeave, againDisabled = false, extraLabel, onExtra }) {
    const n = this.nodes;
    const tone = net > 0 ? 'is-win' : net < 0 ? 'is-loss' : 'is-even';
    const sign = net > 0 ? '+' : net < 0 ? '−' : '';
    const nextBtn = el('button.btn.btn--primary', { type: 'button', disabled: againDisabled, onclick: () => onAgain?.() }, againLabel);
    const extraBtn = extraLabel ? el('button.btn', { type: 'button', onclick: () => onExtra?.() }, extraLabel) : null;
    const leaveBtn = el('button.btn', { type: 'button', onclick: () => onLeave?.() }, 'Leave');
    clear(n.result);
    n.result.append(
      el('span', { class: `he-result__net ${tone}` }, `${sign}${this.fmt(Math.abs(net))}`),
      el('span.he-result__hand', handText),
      el('div.he-result__btns', nextBtn, extraBtn, leaveBtn),
    );
    n.controls.hidden = true;
    n.result.hidden = false;
    if (!againDisabled) nextBtn.focus({ preventScroll: true });
  }

  destroy() {
    document.removeEventListener('keydown', this.onKey);
    clearTimeout(this.captionTimer);
    clearTimeout(this.errorTimer);
    this.teardownFullscreen?.();
    clear(this.root);
  }
}
