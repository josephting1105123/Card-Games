/**
 * Blackjack: mode picker, table picker, and the table itself (view + controller).
 *
 * Dou Di Zhu's table (src/ui/tableview.js) is built around three seats and a
 * trick in the middle; Blackjack is one player against the house, so this is
 * a separate implementation rather than a variant of that one — its own DOM,
 * its own stylesheet (styles/blackjack.css), sharing only the card artwork
 * (cardElement, default options) and the generic .page/.tile/.btn scaffolding
 * from app.css that every screen in the app already uses.
 */

import { formatChips } from '../core/economy.js';
import { makeRng, randomSeed } from '../core/rng.js';
import {
  americanTotal, createShoe, malaysianTotal, needsReshuffle, reshuffleShoe,
} from '../games/blackjack/cards.js';
import * as US from '../games/blackjack/american.js';
import * as MY from '../games/blackjack/malaysian.js';
import { recordBlackjackResult } from '../games/blackjack/stats.js';
import { chipDenominations, tableAccess, tableEntry } from '../games/blackjack/tables.js';
import { gameById } from '../games/registry.js';
import { cardElement, installCardDefs } from './cardart.js';
import { clear, el, wait } from './dom.js';
import { topbar } from './screens.js';

const RULES_TEXT = {
  american: [
    'Six decks in the shoe, reshuffled once about three quarters of it has been dealt.',
    'Dealer stands on all 17s, including a soft 17.',
    'Blackjack pays 3:2. Insurance, offered only when the dealer shows an ace, costs half your bet and pays 2:1.',
    'Double on any first two cards, and after a split too.',
    'Split any pair up to three times, for four hands. Split aces get exactly one card each, cannot be resplit, and a 21 there is just 21 — not blackjack.',
    'Late surrender gives back half your bet, but only on your original two cards, before any split.',
    'Ties push.',
  ],
  malaysian: [
    'A single deck, freshly shuffled every round.',
    'An ace is worth 11 or 10 with two cards, 10 or 1 with three, and always 1 with four or five.',
    'Ban Ban — two aces — pays 3:1. Ban Luck — an ace with a ten-value card — pays 2:1. Both are checked the instant the first two cards land, on both sides of the table.',
    'If the dealer holds a special, the round ends at once: you lose at that multiple unless you hold an equal or better special of your own (ties push; Ban Ban beats Ban Luck).',
    '777 (three sevens) pays 7:1. Five Dragon (five cards totalling 21 or less) pays 2:1, or 3:1 on exactly 21. Both win the instant they are made.',
    'You need at least 16 to stand. A bust loses outright, even if the dealer goes on to bust too.',
    'The dealer draws below 16 and stands from 16. A dealer five-card hand of 21 or less beats any hand without a special of its own, at 2:1.',
    'No doubling, splitting, surrender or insurance. Ties push.',
  ],
};

function variantName(variant) {
  return variant === 'malaysian' ? 'Malaysian (Ban Luck)' : 'American';
}

// ---------------------------------------------------------------------------
// Mode picker: American or Malaysian. No local-multiplayer tile — Blackjack
// is solo against the house in both rule sets.
// ---------------------------------------------------------------------------

export function renderBlackjackMode(app, root) {
  const game = gameById('blackjack');
  clear(root);
  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('menu') }, '← All games'),
      el('div.page__head',
        el('h1.page__title', game.name),
        el('p.page__sub', 'Two house rule sets, one table each. Pick which one you want to sit down at.'),
      ),
      el('div.tiles',
        el('button.tile', { type: 'button', style: '--accent:#1f7a4d', onclick: () => app.go('lobby', { gameId: 'blackjack', variant: 'american' }) },
          el('span.tile__accent'),
          el('h2.tile__name', 'American'),
          el('p.tile__tag', 'Six-deck shoe · dealer stands on 17'),
          el('p.tile__desc', 'Blackjack pays 3:2, insurance against a dealer ace, double on any first two, split a pair up to three times, late surrender on the original two cards.'),
        ),
        el('button.tile', { type: 'button', style: '--accent:#a9701f', onclick: () => app.go('lobby', { gameId: 'blackjack', variant: 'malaysian' }) },
          el('span.tile__accent'),
          el('h2.tile__name', 'Malaysian', el('span.tile__zh', 'Ban Luck')),
          el('p.tile__tag', 'Single deck · reshuffled every round'),
          el('p.tile__desc', 'Ban Ban and Ban Luck pay out the instant they are dealt, 777 and Five Dragon are instant wins, and you need at least 16 to stand.'),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Table picker: Blackjack's own min/max ladder (games/blackjack/tables.js),
// not Dou Di Zhu's pot lobbies.
// ---------------------------------------------------------------------------

export function renderBlackjackLobby(app, root, variantParam) {
  const variant = variantParam === 'malaysian' ? 'malaysian' : 'american';
  const profile = app.profile;
  clear(root);
  const access = tableAccess(profile.bankroll);
  const grid = el('div.lobbies');
  for (const { table, locked, reason } of access) {
    grid.append(el('button.lobby', {
      type: 'button',
      disabled: locked,
      onclick: () => app.go('table', { gameId: 'blackjack', variant, lobbyId: table.id }),
    },
      el('div.lobby__pot', formatChips(table.min, true)),
      el('div.lobby__name', table.name),
      el('div.lobby__meta',
        el('span', `Min ${formatChips(table.min, true)}`),
        el('span', `Max ${formatChips(table.max, true)}`),
        el('span', `Entry ${formatChips(tableEntry(table), true)}`),
      ),
      locked ? el('p.lobby__lock', reason) : null,
    ));
  }

  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('mode', { gameId: 'blackjack' }) }, '← Blackjack'),
      el('div.page__head',
        el('h1.page__title', `${variantName(variant)} tables`),
        el('p.page__sub', 'One seat, against the house. A table is open once your bankroll can survive ten of its minimum bets.'),
      ),
      grid,
    ),
  );
}

// ---------------------------------------------------------------------------
// The table: view + controller.
// ---------------------------------------------------------------------------

const FLIGHT_MS = 300;
const STAGGER_MS = 120;
const DEALER_PACE_MS = 450;
const FLIP_MS = 360;

export class BlackjackGame {
  /**
   * @param {object} app
   * @param {{table: object, variant: string}} options
   */
  constructor(app, { table, variant }) {
    this.app = app;
    this.table = table;
    this.variant = variant === 'malaysian' ? 'malaysian' : 'american';
    this.isAmerican = this.variant === 'american';
    this.engine = this.isAmerican ? US : MY;
    this.bet = table.min;
    this.lastBet = null;
    this.dealerRevealed = false;
    this.rng = makeRng(randomSeed());
  }

  mount(root) {
    installCardDefs();
    this.root = root;
    if (this.isAmerican) this.shoe = createShoe(6, this.rng);
    this.renderBetting();
  }

  unmount() {
    this.stopped = true;
  }

  // --- betting screen ------------------------------------------------------

  canDeal() {
    const bankroll = this.app.profile.bankroll;
    return this.bet >= this.table.min && this.bet <= this.table.max && this.bet <= bankroll && this.bet > 0;
  }

  renderBetting() {
    clear(this.root);
    const profile = this.app.profile;
    const chips = chipDenominations(this.table);

    const betDisplay = el('div.bj-bet-amount', formatChips(this.bet));
    const dealBtn = el('button.btn.btn--primary.btn--big', {
      type: 'button', disabled: !this.canDeal(), onclick: () => this.deal(),
    }, 'Deal');

    const chipRow = el('div.bj-chip-row', ...chips.map((value) => el('button.btn.bj-chip', {
      type: 'button',
      disabled: this.bet + value > this.table.max || this.bet + value > profile.bankroll,
      onclick: () => { this.bet = Math.min(this.bet + value, this.table.max, profile.bankroll); this.renderBetting(); },
    }, formatChips(value, true))));

    const repeatDisabled = !this.lastBet || this.lastBet > this.table.max || this.lastBet > profile.bankroll || this.lastBet < this.table.min;

    this.root.append(
      topbar(this.app),
      el('main.page.bj-betting',
        el('button.back-link', { type: 'button', onclick: () => this.app.go('lobby', { gameId: 'blackjack', variant: this.variant }) }, `← ${variantName(this.variant)} tables`),
        el('div.page__head',
          el('h1.page__title', this.table.name),
          el('p.page__sub', `${variantName(this.variant)} · bets ${formatChips(this.table.min)} to ${formatChips(this.table.max)}`),
        ),
        el('div.card-panel.bj-bet-panel',
          el('div.bj-bet-row',
            el('span.field__label', 'Your bet'),
            betDisplay,
          ),
          chipRow,
          el('div.btn-row',
            el('button.btn', { type: 'button', onclick: () => { this.bet = 0; this.renderBetting(); } }, 'Clear'),
            el('button.btn', { type: 'button', disabled: repeatDisabled, onclick: () => { this.bet = this.lastBet; this.renderBetting(); } }, 'Repeat bet'),
            el('button.btn', { type: 'button', onclick: () => this.showRules() }, 'Rules'),
            dealBtn,
          ),
        ),
      ),
    );
  }

  showRules() {
    const overlay = el('div.bj-overlay',
      el('div.bj-rules',
        el('h2', `${variantName(this.variant)} rules`),
        el('ul', ...RULES_TEXT[this.variant].map((line) => el('li', line))),
        el('div.btn-row', { style: 'justify-content:center' },
          el('button.btn.btn--primary', { type: 'button', onclick: () => overlay.remove() }, 'Close'),
        ),
      ),
    );
    this.root.append(overlay);
  }

  // --- dealing ---------------------------------------------------------------

  deal() {
    if (!this.canDeal()) return;
    this.lastBet = this.bet;
    this.dealerRevealed = false;
    this.justShuffled = false;
    if (this.isAmerican) {
      if (needsReshuffle(this.shoe)) {
        reshuffleShoe(this.shoe, this.rng);
        this.justShuffled = true;
      }
      this.round = US.startRound({ shoe: this.shoe, bet: this.bet });
    } else {
      this.shoe = createShoe(1, this.rng);
      this.round = MY.startRound({ deck: this.shoe, bet: this.bet });
    }
    this.renderTable();
    this.runDealAnimation();
  }

  // --- committed chips, for affordability checks ----------------------------

  committed() {
    if (this.isAmerican) return this.round.hands.reduce((s, h) => s + h.bet, 0) + (this.round.insuranceBet || 0);
    return this.round.player.bet;
  }

  canAffordExtra(extra) {
    return this.app.profile.bankroll - this.committed() >= extra;
  }

  // --- table shell -----------------------------------------------------------

  animationsOn() {
    if (this.app.profile.settings?.animations === false) return false;
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  handsOf() {
    return this.isAmerican ? this.round.hands : [this.round.player];
  }

  totalOf(cards) {
    return this.isAmerican ? americanTotal(cards) : malaysianTotal(cards);
  }

  shoeRemaining() {
    return this.shoe.cards.length - this.shoe.dealt;
  }

  /** Bet at risk, shoe count and bankroll all move as a round plays out. */
  paintHud() {
    const n = this.nodes;
    if (!n.betPill) return;
    n.betPill.querySelector('b').textContent = formatChips(this.committed());
    n.shoePill.querySelector('b').textContent = `${this.shoeRemaining()} left`;
    n.bankrollPill.querySelector('b').textContent = formatChips(this.app.profile.bankroll);
  }

  renderTable() {
    clear(this.root);
    const n = {};
    this.nodes = n;

    n.leaveBtn = el('button.back-link', { type: 'button', 'aria-label': 'Leave table', onclick: () => this.leave() }, '←');
    n.betPill = el('span.bj-hud__pill', el('small', 'At risk'), el('b', formatChips(this.committed())));
    n.bankrollPill = el('span.bj-hud__pill', el('small', 'Bankroll'), el('b', formatChips(this.app.profile.bankroll)));
    n.shoePill = el('span.bj-hud__pill', el('small', this.isAmerican ? 'Shoe' : 'Deck'), el('b', `${this.shoeRemaining()} left`));
    const hud = el('div.bj-hud',
      n.leaveBtn,
      el('span.bj-hud__title', `${this.table.name} · ${variantName(this.variant)}`),
      el('div.bj-hud__spacer'),
      n.shoePill, n.betPill, n.bankrollPill,
      el('button.btn', { type: 'button', onclick: () => this.showRules() }, 'Rules'),
    );

    n.dealerLabel = el('span.bj-dealer__total', '');
    n.dealerCards = el('div.bj-dealer__cards');
    const dealer = el('div.bj-dealer',
      el('div.bj-dealer__row', el('span.bj-dealer__name', 'Dealer'), n.dealerLabel),
      n.dealerCards,
    );

    n.shoeIcon = el('div.bj-shoe', cardElement(null, { faceDown: true }));

    n.handsRow = el('div.bj-hands');
    n.actions = el('div.bj-actions');

    n.felt = el('div.bj-felt', n.shoeIcon, dealer, n.handsRow);
    n.table = el('div.bj-table', hud, n.felt, n.actions);

    this.root.append(
      n.table,
      el('div.bj-rotate-gate',
        el('div',
          el('div.bj-rotate-gate__icon', '↻'),
          el('h2', 'Turn your device'),
          el('p', 'The table is dealt across. Landscape gives every hand room to breathe.'),
        ),
      ),
    );

    this.paintDealer();
    this.paintHands();
    // Actions appear once the deal animation lands (afterDealSettled), not
    // while cards are still in flight.
  }

  paintDealer() {
    const n = this.nodes;
    const cards = this.round.dealer.cards;
    const shown = this.dealerRevealed ? cards.length : Math.min(2, cards.length);
    clear(n.dealerCards);
    for (let i = 0; i < shown; i++) {
      if (i === 1 && !this.dealerRevealed) {
        n.dealerCards.append(el('div.bj-flip', cardElement(null, { faceDown: true })));
      } else {
        n.dealerCards.append(cardElement(cards[i]));
      }
    }
    if (this.dealerRevealed) {
      const t = this.totalOf(cards);
      n.dealerLabel.textContent = t.bust ? 'Bust' : t.soft ? `Soft ${t.total}` : `${t.total}`;
    } else {
      n.dealerLabel.textContent = '';
    }
  }

  handLabel(hand, cards) {
    const t = this.totalOf(cards);
    if (this.isAmerican) {
      if (hand.busted) return 'Bust';
      if (hand.surrendered) return 'Surrendered';
      if (hand.blackjack) return 'Blackjack';
      return t.soft ? `Soft ${t.total}` : `${t.total}`;
    }
    if (hand.busted) return 'Bust';
    if (hand.result === 'banban') return 'Ban Ban';
    if (hand.result === 'banluck') return 'Ban Luck';
    if (hand.result === '777') return '777';
    if (hand.result === 'five-dragon') return 'Five Dragon';
    return t.soft ? `Soft ${t.total}` : `${t.total}`;
  }

  paintHands() {
    const n = this.nodes;
    clear(n.handsRow);
    n.handCardsEls = [];
    const hands = this.handsOf();
    hands.forEach((hand, index) => {
      const cardsEl = el('div.bj-hand__cards');
      n.handCardsEls[index] = cardsEl;
      for (const card of hand.cards) cardsEl.append(cardElement(card));
      const active = this.isAmerican
        ? this.round.phase === 'player' && index === this.round.activeHand
        : this.round.phase === 'player';
      const resultLine = this.round.settled ? el('div.bj-hand__result', resultText(hand, this.isAmerican)) : null;
      n.handsRow.append(el(`div.bj-hand${active ? '.is-active' : ''}`,
        cardsEl,
        el('div.bj-hand__foot',
          el('span.bj-hand__total', this.handLabel(hand, hand.cards)),
          el('span.bj-hand__bet', formatChips(hand.bet)),
        ),
        resultLine,
      ));
    });
    this.paintHud();
  }

  paintActions() {
    const n = this.nodes;
    clear(n.actions);
    if (this.round.phase === 'insurance') {
      n.actions.append(this.buildInsurancePrompt());
      return;
    }
    if (this.round.settled) return; // the result overlay owns the felt now
    if (this.round.phase !== 'player') return;

    if (this.isAmerican) {
      const hand = this.round.hands[this.round.activeHand];
      n.actions.append(
        el('button.btn.btn--primary', { type: 'button', disabled: !US.canHit(this.round), onclick: () => this.onHit() }, 'Hit'),
        el('button.btn', { type: 'button', disabled: !US.canStand(this.round), onclick: () => this.onStand() }, 'Stand'),
        el('button.btn', { type: 'button', disabled: !US.canDouble(this.round) || !this.canAffordExtra(hand.bet), onclick: () => this.onDouble() }, 'Double'),
        el('button.btn', { type: 'button', disabled: !US.canSplit(this.round) || !this.canAffordExtra(hand.bet), onclick: () => this.onSplit() }, 'Split'),
        el('button.btn', { type: 'button', disabled: !US.canSurrender(this.round), onclick: () => this.onSurrender() }, 'Surrender'),
      );
    } else {
      n.actions.append(
        el('button.btn.btn--primary', { type: 'button', disabled: !MY.canHit(this.round), onclick: () => this.onHit() }, 'Hit'),
        el('button.btn', { type: 'button', disabled: !MY.canStand(this.round), onclick: () => this.onStand(), title: MY.canStand(this.round) ? '' : 'Need at least 16 to stand' }, 'Stand'),
      );
    }
  }

  buildInsurancePrompt() {
    const bet = this.round.hands[0].bet;
    const cost = bet / 2;
    const afford = this.canAffordExtra(cost);
    return el('div.bj-insurance',
      el('span', `Insurance costs ${formatChips(cost)} and pays 2:1 if the dealer has blackjack.`),
      el('div.btn-row',
        el('button.btn.btn--primary', { type: 'button', disabled: !afford, onclick: () => this.onInsurance(true) }, 'Yes'),
        el('button.btn', { type: 'button', onclick: () => this.onInsurance(false) }, 'No'),
      ),
    );
  }

  // --- player actions ----------------------------------------------------

  afterAction() {
    this.paintDealer();
    this.paintHands();
    this.paintActions();
    if (this.round.phase === 'dealer' || (this.round.settled && !this.dealerRevealed)) this.revealDealer();
  }

  onHit() {
    const handIndex = this.isAmerican ? this.round.activeHand : 0;
    this.engine.hit(this.round, this.shoe);
    this.afterAction();
    this.pulseLastCard(handIndex);
  }

  pulseLastCard(handIndex) {
    const container = this.nodes.handCardsEls?.[Math.max(0, handIndex)];
    const card = container?.lastElementChild;
    if (!card || !this.animationsOn()) return;
    card.classList.add('bj-card-enter');
    card.addEventListener('animationend', () => card.classList.remove('bj-card-enter'), { once: true });
  }

  onStand() {
    this.engine.stand(this.round);
    this.afterAction();
  }

  onDouble() {
    const handIndex = this.round.activeHand;
    US.double(this.round, this.shoe);
    this.afterAction();
    this.pulseLastCard(handIndex);
  }

  onSplit() {
    const handIndex = this.round.activeHand;
    US.split(this.round, this.shoe);
    this.afterAction();
    this.pulseLastCard(handIndex);
    this.pulseLastCard(handIndex + 1);
  }

  onSurrender() {
    US.surrender(this.round);
    this.afterAction();
  }

  onInsurance(want) {
    US.decideInsurance(this.round, this.shoe, want);
    this.afterAction();
  }

  // --- animation: initial deal --------------------------------------------

  async runDealAnimation() {
    if (this.stopped) return;
    if (this.justShuffled) this.showToast('Shuffling a fresh shoe…');
    if (!this.animationsOn()) {
      await this.afterDealSettled();
      return;
    }
    const n = this.nodes;
    const playerCards = this.isAmerican ? this.round.hands[0].cards : this.round.player.cards;
    const dealerCards = this.round.dealer.cards;
    // Deal order is the same in both rule sets: player, dealer, player, dealer
    // face-down. Everything but the hole card flies as its real face — the
    // hole card flies as a back and stays one until the dealer plays.
    const order = [
      { el: n.handCardsEls[0], i: 0, card: playerCards[0], faceDown: false },
      { el: n.dealerCards, i: 0, card: dealerCards[0], faceDown: false },
      { el: n.handCardsEls[0], i: 1, card: playerCards[1], faceDown: false },
      { el: n.dealerCards, i: 1, card: dealerCards[1], faceDown: true },
    ];

    const shoeRect = n.shoeIcon.getBoundingClientRect();
    const originX = shoeRect.left + shoeRect.width / 2;
    const originY = shoeRect.top + shoeRect.height / 2;
    const layer = el('div.bj-flyers');
    n.felt.append(layer);

    const flights = order.map((slot, index) => {
      const target = slot.el.children[slot.i];
      if (!target) return null;
      target.style.opacity = '0';
      const flyer = slot.faceDown ? cardElement(null, { faceDown: true }) : cardElement(slot.card);
      flyer.classList.add('bj-flyer');
      const rect = target.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - originX;
      const dy = rect.top + rect.height / 2 - originY;
      flyer.style.width = `${rect.width}px`;
      flyer.style.left = `${originX}px`;
      flyer.style.top = `${originY}px`;
      flyer.style.setProperty('--dx', `${dx}px`);
      flyer.style.setProperty('--dy', `${dy}px`);
      flyer.style.setProperty('--i', String(index));
      layer.append(flyer);
      return { flyer, target };
    }).filter(Boolean);

    layer.classList.add('is-flying');
    await Promise.all(flights.map(async ({ flyer, target }, index) => {
      await wait(index * STAGGER_MS + FLIGHT_MS);
      if (this.stopped) return;
      target.style.opacity = '';
      flyer.remove();
    }));
    layer.remove();
    await this.afterDealSettled();
  }

  async afterDealSettled() {
    if (this.stopped) return;
    if (this.round.phase === 'insurance' || this.round.phase === 'player') {
      this.paintActions();
      return;
    }
    // A fast path already resolved the round (a peeked dealer blackjack, or a
    // natural with no dealer blackjack possible) — reveal it the same way a
    // normal finish does.
    await this.revealDealer();
  }

  // --- animation: dealer's turn -------------------------------------------

  async revealDealer() {
    if (this.dealerRevealed || this.stopped) return;
    this.dealerRevealed = true;
    if (!this.round.settled) this.engine.playDealer(this.round, this.shoe);
    this.paintActions();

    if (!this.animationsOn()) {
      this.paintDealer();
      this.finishRound();
      return;
    }

    await this.flipHoleCard();
    if (this.stopped) return;
    const cards = this.round.dealer.cards;
    for (let i = 2; i < cards.length; i++) {
      await wait(DEALER_PACE_MS);
      if (this.stopped) return;
      const node = cardElement(cards[i]);
      node.classList.add('bj-card-enter');
      this.nodes.dealerCards.append(node);
      const t = this.totalOf(cards.slice(0, i + 1));
      this.nodes.dealerLabel.textContent = t.bust ? 'Bust' : t.soft ? `Soft ${t.total}` : `${t.total}`;
      this.paintHud();
    }
    await wait(300);
    if (this.stopped) return;
    this.finishRound();
  }

  /** Flip the hole card face up with a transform-only animation, swapping the
   * face at the midpoint — never a layout property inside the keyframe. */
  async flipHoleCard() {
    const wrap = this.nodes.dealerCards.children[1];
    if (!wrap || !wrap.classList.contains('bj-flip')) {
      this.paintDealer();
      return;
    }
    wrap.classList.add('is-flipping');
    await wait(FLIP_MS / 2);
    if (this.stopped) return;
    clear(wrap);
    wrap.append(cardElement(this.round.dealer.cards[1]));
    await wait(FLIP_MS / 2);
    if (this.stopped) return;
    wrap.classList.remove('is-flipping');
    const t = this.totalOf(this.round.dealer.cards.slice(0, 2));
    this.nodes.dealerLabel.textContent = t.soft ? `Soft ${t.total}` : `${t.total}`;
  }

  showToast(message) {
    const toast = el('div.bj-toast', message);
    this.root.append(toast);
    requestAnimationFrame(() => toast.classList.add('is-on'));
    setTimeout(() => { toast.classList.remove('is-on'); setTimeout(() => toast.remove(), 300); }, 1600);
  }

  // --- settlement ----------------------------------------------------------

  finishRound() {
    const net = this.engine.roundNet(this.round);
    const { stats } = recordBlackjackResult(this.app.profile, 'blackjack', net);
    this.paintDealer();
    this.paintHands();
    clear(this.nodes.actions);
    this.nodes.bankrollPill.querySelector('b').textContent = formatChips(this.app.profile.bankroll);
    this.showResult(net, stats);
  }

  showResult(net, stats) {
    const win = net > 0;
    const push = net === 0;
    const hands = this.handsOf();
    const title = this.resultTitle(hands, net, push);
    const lines = hands.map((hand, i) => {
      const label = this.isAmerican && hands.length > 1 ? `Hand ${i + 1}: ` : '';
      return `${label}${resultText(hand, this.isAmerican)} — <span>${formatChips(hand.payout ?? 0)}</span>`;
    });
    if (this.isAmerican && this.round.insuranceBet) {
      lines.push(`Insurance: <span>${formatChips(this.round.insurancePayout)}</span>`);
    }
    lines.push(`Bankroll: <span>${formatChips(this.app.profile.bankroll)}</span>`);
    lines.push(`Blackjack record: <span>${stats.played} played · ${stats.won} won · net ${formatChips(stats.net)}</span>`);

    const overlay = el('div.bj-overlay',
      el('div.bj-result',
        el('h2', { class: `bj-result__title ${win ? 'is-win' : push ? 'is-push' : 'is-loss'}` }, title),
        el('div', { class: `bj-result__delta ${win ? 'is-win' : push ? 'is-push' : 'is-loss'}` }, `${net >= 0 ? '+' : '−'}${formatChips(Math.abs(net))}`),
        el('ul.bj-result__lines', ...lines.map((line) => el('li', { html: line }))),
        el('div.btn-row', { style: 'justify-content:center' },
          el('button.btn.btn--primary', { type: 'button', onclick: () => { overlay.remove(); this.renderBetting(); } }, 'Continue'),
          el('button.btn', { type: 'button', onclick: () => { overlay.remove(); this.leave(); } }, 'Leave table'),
        ),
      ),
    );
    this.root.append(overlay);
  }

  resultTitle(hands, net, push) {
    if (!this.isAmerican) {
      const r = hands[0].result;
      if (r === 'banban') return 'Ban Ban!';
      if (r === 'banluck') return 'Ban Luck!';
      if (r === '777') return '777!';
      if (r === 'five-dragon') return 'Five Dragon!';
      if (r === 'bust') return 'Bust';
      // The round can also end because the dealer held the special, not the
      // player — say so, rather than a flat "You lose" for a 3x hit.
      const dealerSpecial = this.round.dealer.special;
      if (dealerSpecial === 'banban') return push ? 'Push — Ban Ban' : 'Dealer Ban Ban';
      if (dealerSpecial === 'banluck') return push ? 'Push — Ban Luck' : 'Dealer Ban Luck';
      if (push) return 'Push';
      return net > 0 ? 'You win' : 'You lose';
    }
    if (hands.length === 1 && hands[0].result === 'blackjack') return 'Blackjack!';
    if (push) return 'Push';
    return net > 0 ? 'You win' : 'You lose';
  }

  leave() {
    this.app.go('lobby', { gameId: 'blackjack', variant: this.variant });
  }
}

function resultText(hand, isAmerican) {
  if (isAmerican) {
    switch (hand.result) {
      case 'blackjack': return 'Blackjack, pays 3:2';
      case 'win': return 'Win';
      case 'lose': return 'Lose';
      case 'push': return 'Push';
      case 'bust': return 'Bust';
      case 'surrender': return 'Surrendered';
      default: return '';
    }
  }
  switch (hand.result) {
    case 'banban': return 'Ban Ban, pays 3:1';
    case 'banluck': return 'Ban Luck, pays 2:1';
    case '777': return '777, pays 7:1';
    case 'five-dragon': return 'Five Dragon';
    case 'win': return 'Win';
    case 'lose': return 'Lose';
    case 'push': return 'Push';
    case 'bust': return 'Bust';
    default: return '';
  }
}
