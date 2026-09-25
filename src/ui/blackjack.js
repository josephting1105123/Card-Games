/**
 * Blackjack: mode picker, table picker, and the table itself (view + controller).
 *
 * Dou Di Zhu's table (src/ui/tableview.js) is built around three seats and a
 * trick in the middle; Blackjack is one player against the house, so this is
 * a separate implementation rather than a variant of that one — its own DOM,
 * its own stylesheet (styles/blackjack.css), sharing only the card artwork
 * (cardElement, default options) and the generic .page/.tile/.btn scaffolding
 * from app.css that every screen in the app already uses.
 *
 * Betting and the round itself share one shell (.bj-table: hud + felt +
 * actions) instead of a separate scrolling page — the bet controls are just
 * another thing the action row can hold, the same way it holds Hit/Stand
 * during a round or the insurance prompt right after a deal.
 */

import { formatChips } from '../core/economy.js';
import { gameStats } from '../core/profile.js';
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
    this.round = null;
    this.dealerRevealed = false;
    this.roundFinished = false;
    this.rng = makeRng(randomSeed());
  }

  mount(root) {
    installCardDefs();
    this.root = root;
    // A shoe to show a count from even before the first deal — Malaysian
    // replaces it every round anyway, American keeps this one across rounds.
    this.shoe = createShoe(this.isAmerican ? 6 : 1, this.rng);
    this.renderTable();
    this.paintActions();
  }

  unmount() {
    this.stopped = true;
  }

  // --- betting -------------------------------------------------------------

  canDeal() {
    const bankroll = this.app.profile.bankroll;
    return this.bet >= this.table.min && this.bet <= this.table.max && this.bet <= bankroll && this.bet > 0;
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

  statsLine() {
    const stats = gameStats(this.app.profile, 'blackjack');
    if (!stats.played) return '';
    return `${stats.played} played · ${stats.won} won · net ${formatChips(stats.net ?? 0)}`;
  }

  /** Chips, Clear, Repeat bet and Deal — the action row's content whenever
   * there is no round in progress, whether that's the first bet at this
   * table or the next one right after a result banner. One row: the result
   * banner needs the felt's dealer-to-hand gap to actually have height in
   * it, and a tall, multi-row action bar is what was eating that space. The
   * running played/won/net line moves to a tooltip on the bankroll pill
   * instead of a row of its own — still there, never competing for room. */
  paintBettingControls() {
    const n = this.nodes;
    clear(n.actions);
    n.actions.classList.add('is-betting');
    const profile = this.app.profile;
    const chips = chipDenominations(this.table);
    const repeatDisabled = !this.lastBet || this.lastBet > this.table.max || this.lastBet > profile.bankroll || this.lastBet < this.table.min;

    n.actions.append(
      el('div.bj-chip-row',
        el('div.bj-bet-live', el('span', 'Bet'), el('b', formatChips(this.bet))),
        ...chips.map((value) => el('button.btn.bj-chip', {
          type: 'button',
          disabled: this.bet + value > this.table.max || this.bet + value > profile.bankroll,
          onclick: () => { this.bet = Math.min(this.bet + value, this.table.max, profile.bankroll); this.paintActions(); this.paintHud(); },
        }, formatChips(value, true))),
        el('button.btn', { type: 'button', onclick: () => { this.bet = 0; this.paintActions(); this.paintHud(); } }, 'Clear'),
        el('button.btn', { type: 'button', disabled: repeatDisabled, onclick: () => { this.bet = this.lastBet; this.paintActions(); this.paintHud(); } }, 'Repeat bet'),
        el('button.btn.btn--primary', { type: 'button', disabled: !this.canDeal(), onclick: () => this.deal() }, 'Deal'),
      ),
    );
  }

  // --- dealing ---------------------------------------------------------------

  deal() {
    if (!this.canDeal()) return;
    this.lastBet = this.bet;
    this.dealerRevealed = false;
    this.roundFinished = false;
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
    if (!this.round || this.roundFinished) return this.bet;
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
    if (!this.round) return [];
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
    const inPlay = this.round && !this.roundFinished;
    n.betPill.querySelector('small').textContent = inPlay ? 'At risk' : 'Bet';
    n.betPill.querySelector('b').textContent = formatChips(this.committed());
    n.shoePill.querySelector('b').textContent = `${this.shoeRemaining()} left`;
    n.bankrollPill.querySelector('b').textContent = formatChips(this.app.profile.bankroll);
    // The running played/won/net line rides along as a tooltip — present,
    // but never competing with the cards or the banner for space.
    const stats = this.statsLine();
    if (stats) n.bankrollPill.title = stats;
    else n.bankrollPill.removeAttribute('title');
  }

  renderTable() {
    clear(this.root);
    const n = {};
    this.nodes = n;

    n.leaveBtn = el('button.back-link', { type: 'button', 'aria-label': 'Leave table', onclick: () => this.leave() }, '←');
    n.betPill = el('span.bj-hud__pill', el('small', 'Bet'), el('b', formatChips(this.committed())));
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
    n.bannerHost = el('div.bj-banner-host');
    n.actions = el('div.bj-actions');

    n.felt = el('div.bj-felt', n.shoeIcon, dealer, n.handsRow, n.bannerHost);
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
    // while cards are still in flight — renderTable() itself leaves them
    // blank, except when there is no round to deal for yet (mount() paints
    // betting controls straight after calling this).
  }

  /** The dealer's own hand label: a two-card blackjack or Ban Ban/Ban Luck
   * reads by name, the same way a player's hand already does — never the
   * total that produced it (a "Soft 21" dealer hand is just "Blackjack"). */
  dealerHandLabel(cards) {
    const t = this.totalOf(cards);
    if (t.bust) return 'Bust';
    if (this.isAmerican) {
      if (this.round.dealerBlackjack) return 'Blackjack';
    } else {
      if (this.round.dealer.special === 'banban') return 'Ban Ban';
      if (this.round.dealer.special === 'banluck') return 'Ban Luck';
    }
    return t.soft ? `Soft ${t.total}` : `${t.total}`;
  }

  paintDealer() {
    const n = this.nodes;
    clear(n.dealerCards);
    if (!this.round) { n.dealerLabel.textContent = ''; return; }
    const cards = this.round.dealer.cards;
    const shown = this.dealerRevealed ? cards.length : Math.min(2, cards.length);
    for (let i = 0; i < shown; i++) {
      if (i === 1 && !this.dealerRevealed) {
        n.dealerCards.append(el('div.bj-flip', cardElement(null, { faceDown: true })));
      } else {
        n.dealerCards.append(cardElement(cards[i]));
      }
    }
    n.dealerLabel.textContent = this.dealerRevealed ? this.dealerHandLabel(cards) : '';
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
    if (!this.round) {
      n.handsRow.append(el('div.bj-hint', 'Place your bet, then deal.'));
      this.paintHud();
      return;
    }
    const hands = this.handsOf();
    hands.forEach((hand, index) => {
      const cardsEl = el('div.bj-hand__cards');
      n.handCardsEls[index] = cardsEl;
      for (const card of hand.cards) cardsEl.append(cardElement(card));
      // The ring marks which of several split hands is live — with only one
      // hand there is nothing to distinguish it from, so it stays plain.
      const active = this.isAmerican
        && hands.length > 1 && this.round.phase === 'player' && index === this.round.activeHand;
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
    n.actions.classList.remove('is-betting');
    if (!this.round || this.roundFinished) { this.paintBettingControls(); return; }
    if (this.round.phase === 'insurance') {
      n.actions.append(this.buildInsurancePrompt());
      return;
    }
    if (this.round.settled) return; // still animating the dealer's reveal — finishRound() repaints this
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
      this.nodes.dealerLabel.textContent = this.dealerHandLabel(cards.slice(0, i + 1));
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
    this.nodes.dealerLabel.textContent = this.dealerHandLabel(this.round.dealer.cards.slice(0, 2));
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
    // The running played/won/net line now lives in the betting controls
    // (paintBettingControls -> statsLine), not the banner, so the result
    // here is read for its bankroll side effect only.
    recordBlackjackResult(this.app.profile, 'blackjack', net);
    this.roundFinished = true;
    this.paintDealer();
    this.paintHands();
    this.paintActions(); // roundFinished is true now — this paints the next bet's controls
    this.paintHud();
    this.showBanner(net);
  }

  /** A banner over the middle of the felt, not a modal: both hands stay
   * visible underneath it, and the betting controls for the next round are
   * already live in the action row by the time this appears — one tap on
   * Deal is all the next round needs. Positioned at the measured midpoint
   * between the dealer's cards and the player's, the same way the deal
   * flight measures real rects rather than trusting a CSS guess — the gap
   * between two rows of cards each a quarter of the screen tall is too thin
   * a margin to hit by centering in the felt as a whole. */
  showBanner(net) {
    const win = net > 0;
    const push = net === 0;
    const hands = this.handsOf();
    const cls = win ? 'is-win' : push ? 'is-push' : 'is-loss';
    const title = this.resultTitle(hands, net, push);
    const reason = this.resultReason(hands, net, push);
    const banner = el('div.bj-banner',
      { class: cls },
      el('div.bj-banner__main', el('span.bj-banner__title', title), el('span.bj-banner__delta', `${net >= 0 ? '+' : '−'}${formatChips(Math.abs(net))}`)),
      reason ? el('div.bj-banner__reason', reason) : null,
    );
    const n = this.nodes;
    clear(n.bannerHost);
    n.bannerHost.append(banner);

    const feltRect = n.felt.getBoundingClientRect();
    const dealerRect = n.dealerCards.getBoundingClientRect();
    const handRect = n.handsRow.getBoundingClientRect();
    // A few px of deliberate slack, not just the bare midpoint: at the
    // shortest viewport the gap and the (CSS-shrunk) banner are close enough
    // in height that an exact split leaves sub-pixel rounding as the only
    // margin, and this is a rect-intersection check, not a rendering nicety.
    const safeTop = dealerRect.bottom + 3;
    const safeBottom = handRect.top - 3;
    const gapMid = (safeTop + safeBottom) / 2;
    const top = Math.min(Math.max(gapMid - feltRect.top, 0), feltRect.height);
    banner.style.top = `${top}px`;
    requestAnimationFrame(() => banner.classList.add('is-on'));
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

  /** A one-line reason under the banner's title — "Dealer 20 beats 19", not
   * just the amount. Multi-hand splits get a tally instead of one hand's
   * story, since a split round rarely has a single reason. */
  resultReason(hands, net, push) {
    if (!this.isAmerican) {
      const p = hands[0];
      const dealerTotal = this.totalOf(this.round.dealer.cards).total;
      const playerTotal = this.totalOf(p.cards).total;
      switch (p.result) {
        case 'banban': return 'Pays 3:1';
        case 'banluck': return 'Pays 2:1';
        case '777': return 'Three sevens, pays 7:1';
        case 'five-dragon': return `Five cards at ${playerTotal}, pays ${playerTotal === 21 ? 3 : 2}:1`;
        case 'bust': return `You bust with ${playerTotal}`;
        default: break;
      }
      const dealerSpecial = this.round.dealer.special;
      if (dealerSpecial === 'banban' || dealerSpecial === 'banluck') {
        return push ? 'Matched by your own special' : `Pays ${dealerSpecial === 'banban' ? 3 : 2}:1 to the dealer`;
      }
      if (this.round.dealer.cards.length === 5 && dealerTotal <= 21 && p.result === 'lose') {
        return `Dealer's five-card ${dealerTotal} beats ${playerTotal}`;
      }
      if (dealerTotal > 21) return `Dealer busts with ${dealerTotal}`;
      if (push) return `Push at ${playerTotal}`;
      return net > 0 ? `${playerTotal} beats dealer's ${dealerTotal}` : `Dealer ${dealerTotal} beats ${playerTotal}`;
    }
    if (hands.length > 1) {
      const won = hands.filter((h) => h.payout > 0).length;
      const lost = hands.filter((h) => h.payout < 0).length;
      const pushed = hands.filter((h) => h.payout === 0).length;
      return `${won} won · ${lost} lost · ${pushed} push`;
    }
    const hand = hands[0];
    const dealerTotal = this.totalOf(this.round.dealer.cards).total;
    const playerTotal = this.totalOf(hand.cards).total;
    if (hand.result === 'blackjack') return 'Pays 3:2';
    if (hand.result === 'surrender') return 'Surrendered — half the bet back';
    if (hand.result === 'bust') return `You bust with ${playerTotal}`;
    if (this.round.dealerBlackjack) return hand.result === 'push' ? 'Dealer has blackjack too' : 'Dealer has blackjack';
    if (dealerTotal > 21) return `Dealer busts with ${dealerTotal}`;
    if (push) return `Push at ${playerTotal}`;
    return net > 0 ? `${playerTotal} beats dealer's ${dealerTotal}` : `Dealer ${dealerTotal} beats ${playerTotal}`;
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
