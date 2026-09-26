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
 *
 * American is the single-hand table below (renderTable..showBanner): one
 * player, one house dealer. Malaysian is a different shape entirely — one
 * table, five boxes (a banker and four seats), the human in exactly one of
 * them at a time — so it gets its own render/paint/deal methods from
 * renderMalaysianTable() down, sharing only the generic hud/felt/actions/
 * banner chrome and card art, never the American methods above it.
 */

import { formatChips } from '../core/economy.js';
import { blackjackSeatBots, gameStats, setBlackjackSeatBot } from '../core/profile.js';
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
import { enableTableFullscreen } from './fullscreen.js';
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
    'One table, five boxes: a banker up top and four seats below. You always occupy one of them — Swap moves you between the banker box and seat 1, and works only between rounds. Any of the four seats may hold a bot or sit empty; add or remove one with the seat\'s own button, also only between rounds.',
    'A single deck, freshly shuffled every round. An ace is worth 11 or 10 with two cards, 10 or 1 with three, and always 1 with four or five.',
    'Ban Ban — two aces — pays 3:1. Ban Luck — an ace with a ten-value card — pays 2:1. Both are checked the instant the first two cards land, on every hand at the table, banker included.',
    'Run comes first: an opening two-card 15 may run instead of playing out — an instant push, bet back — before the banker\'s own special, if any, is even revealed. Decline by hitting and the banker\'s special, if held, settles that hand at once: a loss at its multiple, unless the hand holds an equal-or-better special of its own (ties push; Ban Ban beats Ban Luck).',
    '777 (three sevens) pays 7:1. Five Dragon (five cards totalling 21 or less) pays 2:1, or 3:1 on exactly 21 — both settle the instant they are made, on any seat or the banker\'s own hand.',
    'Seats act in turn: 16 to stand, five cards the ceiling. A bust loses outright but is not revealed until the banker opens that hand.',
    'The banker draws below 16 and, once at 16 or more, opens seats at will — each opening settles that seat against the banker\'s total at that moment, so a later draw only changes what is compared against for seats opened after it. A banker five-card 21-or-under beats any hand without a special of its own, at 2:1 (3:1 on exactly 21); a banker bust wins every still-unopened seat except one that had busted itself, which pushes.',
    'As a player, every seat\'s cards — yours and every bot\'s — are face up as they are dealt and drawn; the banker\'s own hole card stays hidden until the banker\'s turn begins. As banker, every seat stays face down until you open it.',
    'A bot bets and plays with its own stake, decided from its own cards alone — its result never touches your bankroll unless you are the one banking, in which case your bankroll needs 7x the table\'s maximum bet for every seat a bot fills.',
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
// Malaysian merged table: seats/banker pacing (spec calls for 600-800ms for a
// bot player's own action, ~700ms for a bot banker's), and how long a deal's
// individual cards stagger by so "seats in order, then the banker" actually
// reads as dealt in that order rather than appearing all at once.
const SEAT_PACE_MS = 700;
const BANKER_PACE_MS = 700;
const MDEAL_STAGGER_MS = 130;

// A reversal glyph (⇅) drawn as paths, not the emoji character — the spec
// calls for "no emoji font dependence", and a missing/inconsistent emoji
// font is exactly the failure mode a literal ⇅ character risks.
const SWAP_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
  + '<path d="M8 3v14"/><path d="M5 6l3-3 3 3"/><path d="M16 21V7"/><path d="M13 18l3 3 3-3"/></svg>';

/** One box on the Malaysian table — the banker's, or one of the four seats'.
 * A seat is a real <button> (it is sometimes the tap target to open a hand,
 * and always the between-rounds +Bot/× control); the banker box is never
 * tapped by anyone, so it stays a plain <div>. */
function createMBox({ button = false } = {}) {
  const nameEl = el('span.bj-box__name', '');
  const betEl = el('span.bj-box__bet', '');
  const cardsHost = el('div.bj-box__cards');
  const totalEl = el('span.bj-box__total', '');
  const resultEl = el('div.bj-box__result', '');
  const row = el('div.bj-box__row', nameEl, betEl);
  const box = button
    ? el('button.bj-box', { type: 'button', disabled: true }, row, cardsHost, totalEl, resultEl)
    : el('div.bj-box', row, cardsHost, totalEl, resultEl);
  return { box, nameEl, betEl, cardsHost, totalEl, resultEl };
}

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
    this.bet = table.min;
    this.lastBet = null;
    this.round = null; // American round only — see the class comment up top
    this.dealerRevealed = false;
    this.roundFinished = false;
    this.teardownFullscreen = null;
    this.rng = makeRng(randomSeed());

    // Malaysian only, from here down. `role` is which of the five boxes the
    // human sits in — never persisted, so a reload always starts as a player;
    // `seatBots` (which of the four seats hold a bot) is the one thing that
    // does persist, in the profile, so it survives a reload.
    this.role = 'player';
    this.seatBots = blackjackSeatBots(this.app.profile);
    this.mround = null;
    this.mFinished = true; // no round dealt yet — idle controls show straight away
    this.mDeck = null;
    this.mBankerRevealed = false;
    // Bumped by paintMIdle()/paintMRoundStart() — every point the table is
    // reset to a fresh idle or a fresh deal. A human banker's onMOpenSeat()
    // is async (it awaits its own flip animation before mutating the round),
    // so a bulk auto-settle from a *different*, faster action (the banker's
    // own Hit busting, which settles every still-unopened seat at once) can
    // finish the round while that flip is still in flight; if the player then
    // swaps away before the flip's tail resumes, this token lets that tail
    // recognise the table has moved on and stop touching it.
    this.mEpoch = 0;
  }

  mount(root) {
    installCardDefs();
    this.root = root;
    // A shoe to show a count from even before the first deal — Malaysian
    // replaces its deck every round anyway, American keeps this one across
    // rounds.
    this.shoe = createShoe(this.isAmerican ? 6 : 1, this.rng);
    if (this.isAmerican) {
      this.renderTable();
      this.paintActions();
    } else {
      this.renderMalaysianTable();
      this.paintMIdle();
      this.paintMActions();
    }
  }

  unmount() {
    this.stopped = true;
    this.teardownFullscreen?.();
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
    if (needsReshuffle(this.shoe)) {
      reshuffleShoe(this.shoe, this.rng);
      this.justShuffled = true;
    }
    this.round = US.startRound({ shoe: this.shoe, bet: this.bet });
    this.renderTable();
    this.runDealAnimation();
  }

  // --- committed chips, for affordability checks ----------------------------

  committed() {
    if (!this.round || this.roundFinished) return this.bet;
    return this.round.hands.reduce((s, h) => s + h.bet, 0) + (this.round.insuranceBet || 0);
  }

  canAffordExtra(extra) {
    return this.app.profile.bankroll - this.committed() >= extra;
  }

  // --- table shell -----------------------------------------------------------

  animationsOn() {
    if (this.app.profile.settings?.animations === false) return false;
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
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
    n.shoePill = el('span.bj-hud__pill', el('small', 'Shoe'), el('b', `${this.shoeRemaining()} left`));
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
    // renderTable() rebuilds the whole felt every round (deal() calls it
    // again) — tear down the previous fullscreen wiring first, or its
    // document-level fullscreenchange listener and toggle button pile up on
    // detached nodes each round.
    this.teardownFullscreen?.();
    this.teardownFullscreen = enableTableFullscreen(n.table, hud);

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
    const t = americanTotal(cards);
    if (t.bust) return 'Bust';
    if (this.round.dealerBlackjack) return 'Blackjack';
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
    const t = americanTotal(cards);
    if (hand.busted) return 'Bust';
    if (hand.surrendered) return 'Surrendered';
    if (hand.blackjack) return 'Blackjack';
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
    const hands = this.round.hands;
    hands.forEach((hand, index) => {
      const cardsEl = el('div.bj-hand__cards');
      n.handCardsEls[index] = cardsEl;
      for (const card of hand.cards) cardsEl.append(cardElement(card));
      // The ring marks which of several split hands is live — with only one
      // hand there is nothing to distinguish it from, so it stays plain.
      const active = hands.length > 1 && this.round.phase === 'player' && index === this.round.activeHand;
      const resultLine = this.round.settled ? el('div.bj-hand__result', resultText(hand)) : null;
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

    const hand = this.round.hands[this.round.activeHand];
    n.actions.append(
      el('button.btn.btn--primary', { type: 'button', disabled: !US.canHit(this.round), onclick: () => this.onHit() }, 'Hit'),
      el('button.btn', { type: 'button', disabled: !US.canStand(this.round), onclick: () => this.onStand() }, 'Stand'),
      el('button.btn', { type: 'button', disabled: !US.canDouble(this.round) || !this.canAffordExtra(hand.bet), onclick: () => this.onDouble() }, 'Double'),
      el('button.btn', { type: 'button', disabled: !US.canSplit(this.round) || !this.canAffordExtra(hand.bet), onclick: () => this.onSplit() }, 'Split'),
      el('button.btn', { type: 'button', disabled: !US.canSurrender(this.round), onclick: () => this.onSurrender() }, 'Surrender'),
    );
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
    const handIndex = this.round.activeHand;
    US.hit(this.round, this.shoe);
    this.afterAction();
    this.pulseLastCard(handIndex);
  }

  /** Pulses the last card in one of American's own hand fans (this.nodes) —
   * Malaysian's seats live in a different node namespace and pulse via
   * pulseCard() below directly. */
  pulseLastCard(handIndex) {
    const container = this.nodes.handCardsEls?.[Math.max(0, handIndex)];
    this.pulseCard(container?.lastElementChild);
  }

  /** Transform/opacity only (bj-card-enter, blackjack.css) — a card that just
   * landed gets a small pop, shared by American's hand fans and Malaysian's
   * seat boxes alike. */
  pulseCard(card) {
    if (!card || !this.animationsOn()) return;
    card.classList.add('bj-card-enter');
    card.addEventListener('animationend', () => card.classList.remove('bj-card-enter'), { once: true });
  }

  onStand() {
    US.stand(this.round);
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
    const playerCards = this.round.hands[0].cards;
    const dealerCards = this.round.dealer.cards;
    // Deal order: player, dealer, player, dealer face-down. Everything but
    // the hole card flies as its real face — the hole card flies as a back
    // and stays one until the dealer plays.
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
    if (!this.round.settled) US.playDealer(this.round, this.shoe);
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
    const net = US.roundNet(this.round);
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
    const hands = this.round.hands;
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
    if (hands.length === 1 && hands[0].result === 'blackjack') return 'Blackjack!';
    if (push) return 'Push';
    return net > 0 ? 'You win' : 'You lose';
  }

  /** A one-line reason under the banner's title — "Dealer 20 beats 19", not
   * just the amount. Multi-hand splits get a tally instead of one hand's
   * story, since a split round rarely has a single reason. */
  resultReason(hands, net, push) {
    if (hands.length > 1) {
      const won = hands.filter((h) => h.payout > 0).length;
      const lost = hands.filter((h) => h.payout < 0).length;
      const pushed = hands.filter((h) => h.payout === 0).length;
      return `${won} won · ${lost} lost · ${pushed} push`;
    }
    const hand = hands[0];
    const dealerTotal = americanTotal(this.round.dealer.cards).total;
    const playerTotal = americanTotal(hand.cards).total;
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

  // ===========================================================================
  // The Malaysian table: one banker box, four seats, the human in one of
  // them. See the class comment up top for why this owns its own render/
  // paint/deal methods rather than sharing American's.
  // ===========================================================================

  /** Seats that would hold a bot if the human were banking right now — the
   * one number both the Deal-as-banker gate and the 7x-per-seat bankroll
   * requirement key off, whether or not the human is actually banking yet
   * (swapping-to-banker checks the bankroll against this same count). */
  mFilledSeatCountAsBanker() {
    return this.seatBots.filter(Boolean).length;
  }

  /** Seat descriptors for MY.startTableRound(): seat 0 is the human whenever
   * they are playing (never a bot config's business), every other seat is a
   * bot or empty per this.seatBots — and when the human is banking, seat 0
   * follows that same array like the rest. */
  buildSeatDescriptors() {
    return [0, 1, 2, 3].map((i) => {
      if (this.role === 'player' && i === 0) return { isHuman: true, name: 'You', bet: this.bet };
      return this.seatBots[i] ? { isHuman: false, name: MY.BOT_NAMES[i] } : null;
    });
  }

  renderMalaysianTable() {
    clear(this.root);
    const n = {};
    this.mnodes = n;

    n.leaveBtn = el('button.back-link', { type: 'button', 'aria-label': 'Leave table', onclick: () => this.leave() }, '←');
    n.bankrollPill = el('span.bj-hud__pill', el('small', 'Bankroll'), el('b', formatChips(this.app.profile.bankroll)));
    n.deckPill = el('span.bj-hud__pill', el('small', 'Deck'), el('b', '0 left'));
    const hud = el('div.bj-hud',
      n.leaveBtn,
      el('span.bj-hud__title', `${this.table.name} · Malaysian (Ban Luck)`),
      el('div.bj-hud__spacer'),
      n.deckPill, n.bankrollPill,
      el('button.btn', { type: 'button', onclick: () => this.showRules() }, 'Rules'),
    );

    n.banker = createMBox();
    n.seats = [0, 1, 2, 3].map(() => createMBox({ button: true }));
    const seatRow = el('div.bj-seatrow', ...n.seats.map((s) => s.box));

    n.swapNote = el('span.bj-swap__note', '');
    n.swapBtn = el('button.bj-swap', { type: 'button', onclick: () => this.onSwap() },
      el('span.bj-swap__icon', { html: SWAP_ICON_SVG }),
      el('span.bj-swap__label', 'Swap'),
      n.swapNote,
    );

    // Swap lives in its own row (not the mtable's own middle slot directly)
    // so the result banner can sit beside it, between rounds, without
    // hiding it — swap must stay visible and tappable the moment a round
    // settles, not just once Deal/a bot toggle clears the banner.
    n.midRow = el('div.bj-midrow', n.swapBtn);
    n.mtable = el('div.bj-mtable', n.banker.box, n.midRow, seatRow);

    n.shoeIcon = el('div.bj-shoe', cardElement(null, { faceDown: true }));
    n.actions = el('div.bj-actions');

    // No absolute banner-host here (unlike American's table, below): the
    // result banner joins the swap button in its own row (showMBanner/
    // restoreSwapSlot) so flexbox keeps both clear of the banker box, the
    // seat row and every card in them — nothing to measure or clamp against.
    n.felt = el('div.bj-felt', n.shoeIcon, n.mtable);
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

  paintMHud() {
    const n = this.mnodes;
    n.bankrollPill.querySelector('b').textContent = formatChips(this.app.profile.bankroll);
    // No shoe exists yet before the first deal — Malaysian builds a fresh
    // one every round — so hide the count rather than show a misleading
    // "0 left".
    n.deckPill.style.display = this.mDeck ? '' : 'none';
    if (this.mDeck) {
      const left = this.mDeck.cards.length - this.mDeck.dealt;
      n.deckPill.querySelector('b').textContent = `${left} left`;
    }
  }

  /** Between rounds: the banker box and every seat show the idle state — a
   * bot's name and a "×" to remove it, or "+ Bot" on an empty seat — rather
   * than the last round's cards. This is also what a fresh mount() paints
   * before anything has ever been dealt. */
  paintMIdle() {
    const n = this.mnodes;
    this.mEpoch++; // invalidate any in-flight onMOpenSeat() tail from the round just left
    this.restoreSwapSlot();
    const b = n.banker;
    const bankerIsYou = this.role === 'banker';
    b.box.classList.toggle('bj-box--you', bankerIsYou);
    b.nameEl.textContent = bankerIsYou ? 'You' : 'Banker';
    b.betEl.textContent = '';
    clear(b.cardsHost);
    b.totalEl.textContent = '';
    b.resultEl.textContent = '';
    b.resultEl.className = 'bj-box__result';

    for (let i = 0; i < 4; i++) this.paintSeatIdle(i);
    this.paintMHud();
  }

  /** One seat's between-rounds affordance: a bot's name and "×" to remove
   * it, or "+ Bot" on an empty seat, gated by the same 7x-per-seat bankroll
   * rule Swap-to-banker uses. Shared by paintMIdle() (every seat, the true
   * idle view) and paintMSettled() (only the seats that stayed empty last
   * round — an occupied one keeps its just-finished hand instead). */
  paintSeatIdle(i) {
    const s = this.mnodes.seats[i];
    clear(s.cardsHost);
    s.totalEl.textContent = '';
    s.resultEl.textContent = '';
    s.resultEl.className = 'bj-box__result';
    s.box.classList.remove('is-openable', 'is-active');
    const isYouSeat = this.role === 'player' && i === 0;
    s.box.classList.toggle('bj-box--you', isYouSeat);
    if (isYouSeat) {
      s.nameEl.textContent = 'You';
      s.betEl.textContent = '';
      s.box.disabled = true;
      s.box.onclick = null;
      s.box.title = '';
      return;
    }
    const hasBot = this.seatBots[i];
    s.nameEl.textContent = hasBot ? MY.BOT_NAMES[i] : `Seat ${i + 1}`;
    s.betEl.textContent = hasBot ? '×' : '+ Bot';
    const addReq = MY.bankRequirement(this.table, this.mFilledSeatCountAsBanker() + 1);
    const blocked = !hasBot && this.role === 'banker' && this.app.profile.bankroll < addReq;
    s.box.disabled = blocked;
    s.box.title = blocked ? `Needs ${formatChips(addReq, true)} bankroll to add a bot` : '';
    s.box.onclick = () => this.onToggleSeatBot(i);
  }

  /** Right after a round ends: every box that held a hand keeps showing it —
   * cards, total and result exactly as they finished — so the player can
   * see why they won or lost. Only a seat that stayed empty gets the usual
   * "+ Bot" idle affordance (paintSeatIdle); a bot's box becomes the "×
   * remove" tap target again, and the human's own box (seat or banker)
   * stays inert either way. Nothing here moves until Deal, Swap or a bot
   * toggle actually changes the table (paintMRoundStart/paintMIdle). */
  paintMSettled() {
    this.mnodes.seats.forEach((s, i) => {
      const p = this.mround.players[i];
      if (!p) { this.paintSeatIdle(i); return; }
      // A banker bust or banker special settles unopened seats in bulk
      // without painting them, so their results would otherwise stay blank.
      this.paintMSeat(i);
      s.box.classList.remove('is-openable', 'is-active');
      if (p.isHuman) {
        s.box.disabled = true;
        s.box.onclick = null;
        s.box.title = '';
      } else {
        s.box.disabled = false;
        s.box.onclick = () => this.onToggleSeatBot(i);
        s.box.title = '';
      }
    });
    this.paintMHud();
  }

  /** Adding/removing a bot: between rounds only, and adding one while
   * banking is gated the same 7x-per-filled-seat way Swap-to-banker is. */
  onToggleSeatBot(i) {
    if (this.mround && !this.mFinished) return;
    // A banker tapping seats open can land one tap just after the round
    // settles; without this grace period that tap would remove the bot.
    if (this.mFinished && performance.now() - this.mSettledAt < 800) return;
    const hasBot = this.seatBots[i];
    if (!hasBot && this.role === 'banker') {
      const req = MY.bankRequirement(this.table, this.mFilledSeatCountAsBanker() + 1);
      if (this.app.profile.bankroll < req) return;
    }
    this.seatBots = setBlackjackSeatBot(this.app.profile, i, !hasBot);
    this.paintMIdle();
    this.paintMActions();
  }

  /** Moves the human between the banker box and seat 1. Between rounds
   * only; swapping to banker also needs the bankroll for whatever seats are
   * currently configured as bots (0 filled seats needs 0 — Deal itself is
   * what then asks for at least one). */
  onSwap() {
    if (this.mround && !this.mFinished) return;
    if (this.role === 'player') {
      const req = MY.bankRequirement(this.table, this.mFilledSeatCountAsBanker());
      if (this.app.profile.bankroll < req) return;
      this.role = 'banker';
    } else {
      this.role = 'player';
    }
    this.paintMIdle();
    this.paintMActions();
  }

  /** Swap's own enabled/disabled state and, when it is disabled by the
   * bankroll (not just "mid-round"), the amount that would unblock it. */
  paintMSwap() {
    const n = this.mnodes;
    const midRound = !!this.mround && !this.mFinished;
    let disabled = midRound;
    let note = '';
    if (midRound) {
      note = 'Only between rounds';
    } else if (this.role === 'player') {
      const req = MY.bankRequirement(this.table, this.mFilledSeatCountAsBanker());
      if (this.app.profile.bankroll < req) { disabled = true; note = `Needs ${formatChips(req, true)} to bank`; }
    }
    n.swapBtn.disabled = disabled;
    n.swapBtn.title = note;
    n.swapNote.textContent = note;
    // Visible text, not just a title tooltip touch has no hover for — and
    // it costs no space at all when there is nothing to say, the common case.
    n.swapNote.style.display = note ? '' : 'none';
  }

  paintMActions() {
    const n = this.mnodes;
    clear(n.actions);
    n.actions.classList.remove('is-betting');
    this.paintMSwap();

    if (!this.mround || this.mFinished) {
      if (this.role === 'player') {
        this.paintMBettingControls();
      } else {
        const filled = this.mFilledSeatCountAsBanker();
        n.actions.append(el('button.btn.btn--primary', {
          type: 'button', disabled: filled < 1, onclick: () => this.dealM(),
        }, filled < 1 ? 'Add a bot to deal' : 'Deal'));
        // Visible, not just each blocked seat's own title — the bankroll
        // reason a touch device can never see on hover.
        const addReq = MY.bankRequirement(this.table, filled + 1);
        if (filled < 4 && this.app.profile.bankroll < addReq) {
          n.actions.append(el('span.bj-hint', `Needs ${formatChips(addReq, true)} bankroll to add a bot`));
        }
      }
      return;
    }

    if (this.mround.phase === 'players') {
      const i = this.mround.activeSeat;
      const p = this.mround.players[i];
      if (!p?.isHuman) {
        n.actions.append(el('span.bj-hint', 'The table is playing its hands…'));
        return;
      }
      if (MY.canRunSeat(this.mround, i)) {
        n.actions.append(el('button.btn.btn--primary', { type: 'button', onclick: () => this.onMRun() }, 'Run'));
      }
      n.actions.append(
        el('button.btn', { type: 'button', disabled: !MY.canHitSeat(this.mround, i), onclick: () => this.onMHit() }, 'Hit'),
        el('button.btn', {
          type: 'button', disabled: !MY.canStandSeat(this.mround, i), onclick: () => this.onMStand(),
          title: MY.canStandSeat(this.mround, i) ? '' : 'Need at least 16 to stand',
        }, 'Stand'),
      );
      return;
    }

    if (this.mround.phase === 'banker') {
      if (this.role === 'banker') {
        n.actions.append(
          el('button.btn.btn--primary', { type: 'button', disabled: !MY.canBankerHit(this.mround), onclick: () => this.onMBankerHit() }, 'Hit'),
          el('span.bj-hint', 'Tap a seat to open'),
        );
      } else {
        n.actions.append(el('span.bj-hint', 'The banker is playing it out…'));
      }
    }
    // 'settled' shows nothing here — finishMRound() repaints the idle/betting
    // controls once the banner is up.
  }

  /** Same shape as American's paintBettingControls(), in Malaysian's own
   * node namespace and calling Malaysian's own deal/paint methods. */
  paintMBettingControls() {
    const n = this.mnodes;
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
          onclick: () => { this.bet = Math.min(this.bet + value, this.table.max, profile.bankroll); this.paintMActions(); },
        }, formatChips(value, true))),
        el('button.btn', { type: 'button', onclick: () => { this.bet = 0; this.paintMActions(); } }, 'Clear'),
        el('button.btn', { type: 'button', disabled: repeatDisabled, onclick: () => { this.bet = this.lastBet; this.paintMActions(); } }, 'Repeat bet'),
        el('button.btn.btn--primary', { type: 'button', disabled: !this.canDeal(), onclick: () => this.dealM() }, 'Deal'),
      ),
    );
  }

  // --- dealing ---------------------------------------------------------------

  async dealM() {
    if (this.role === 'player') {
      if (!this.canDeal()) return;
      this.lastBet = this.bet;
    } else if (this.mFilledSeatCountAsBanker() < 1) {
      return;
    }
    this.mFinished = false;
    this.mBankerRevealed = false;
    // A single deck, freshly shuffled every round — the rule this table has
    // always followed, human-banked or not.
    this.mDeck = createShoe(1, this.rng);
    const seats = this.buildSeatDescriptors();
    this.mround = MY.startTableRound({
      deck: this.mDeck, table: this.table, rng: this.rng, seats, bankerIsHuman: this.role === 'banker',
    });
    this.paintMRoundStart();
    // No Hit/Stand/Run (or anything else) until the deal has actually
    // landed on the felt — a tap during the flight must do nothing, so
    // there is nothing tappable to show yet.
    clear(this.mnodes.actions);
    await this.runMDealAnimation();
    if (this.stopped) return;
    this.paintMAll();
    this.paintMActions();
    await this.advanceMTurns();
  }

  /** Wipes every box back to blank (no toggle affordance, no stale banner)
   * right as a new round starts, and sets each occupied box's static label
   * (name/"You") — runMDealAnimation() then fills in the cards themselves. */
  paintMRoundStart() {
    const n = this.mnodes;
    this.mEpoch++; // same invalidation as paintMIdle() — see this.mEpoch's own comment
    this.restoreSwapSlot();
    n.seats.forEach((s, i) => {
      s.box.onclick = null;
      s.box.disabled = true;
      s.box.title = '';
      s.box.classList.remove('is-openable', 'is-active');
      clear(s.cardsHost);
      s.betEl.textContent = '';
      s.totalEl.textContent = '';
      s.resultEl.textContent = '';
      s.resultEl.className = 'bj-box__result';
      const p = this.mround.players[i];
      s.box.classList.toggle('bj-box--you', !!p?.isHuman);
      s.nameEl.textContent = p ? (p.isHuman ? 'You' : p.name) : `Seat ${i + 1}`;
    });
    const b = n.banker;
    clear(b.cardsHost);
    b.totalEl.textContent = '';
    b.resultEl.textContent = '';
    b.resultEl.className = 'bj-box__result';
    const bankerYou = this.role === 'banker';
    b.box.classList.toggle('bj-box--you', bankerYou);
    b.nameEl.textContent = bankerYou ? 'You' : 'Banker';
    this.paintMHud();
  }

  /** "Deal two each (seats in order, then the banker), with visible pacing" —
   * one paint per occupant, staggered, rather than everything landing at
   * once. The paints already reflect final state (MY.startTableRound() has
   * run by the time this is called), including any bot that ran or was paid
   * a special at the deal — those just appear resolved the moment their box
   * is first painted, in step with the same seats-then-banker order. */
  async runMDealAnimation() {
    const n = this.mnodes;
    const occupied = [0, 1, 2, 3].filter((i) => this.mround.players[i]);
    if (!this.animationsOn()) {
      occupied.forEach((i) => this.paintMSeat(i));
      this.paintMBanker();
      return;
    }
    for (const i of occupied) {
      await wait(MDEAL_STAGGER_MS);
      if (this.stopped) return;
      this.paintMSeat(i);
      this.pulseCard(n.seats[i].cardsHost.lastElementChild);
    }
    await wait(MDEAL_STAGGER_MS);
    if (this.stopped) return;
    this.paintMBanker();
  }

  /** Every box, from the round's current (already-settled-where-applicable)
   * state — used once after the deal lands and again whenever a step needs
   * to refresh everything rather than one box. */
  paintMAll() {
    for (let i = 0; i < 4; i++) this.paintMSeat(i);
    this.paintMBanker();
    this.paintMHud();
  }

  /**
   * One seat's box. Visibility follows the spec: as a player, every seat's
   * cards (yours and every bot's) are face up the moment they are dealt or
   * drawn; as banker, a seat stays face down until MY.openSeat() has run for
   * it (`p.opened`) regardless of how many cards it holds.
   *
   * @param {number} i
   * @param {{revealCount?: number}} [opts] `revealCount` shows only the
   *   first N cards — used mid-turn by animateMSeatTurn() so a bot's hits
   *   appear one at a time instead of jumping straight to the final fan.
   */
  paintMSeat(i, opts = {}) {
    const n = this.mnodes.seats[i];
    const p = this.mround?.players[i];
    if (!p) {
      clear(n.cardsHost);
      n.betEl.textContent = ''; n.totalEl.textContent = ''; n.resultEl.textContent = '';
      n.resultEl.className = 'bj-box__result';
      n.nameEl.textContent = `Seat ${i + 1}`;
      n.box.classList.remove('bj-box--you', 'is-active', 'is-openable');
      return;
    }
    n.box.classList.toggle('bj-box--you', p.isHuman);
    n.nameEl.textContent = p.isHuman ? 'You' : p.name;
    n.betEl.textContent = formatChips(p.bet);
    const faceUp = this.role === 'player' || p.opened;
    const revealCount = Math.min(opts.revealCount ?? p.cards.length, p.cards.length);
    clear(n.cardsHost);
    for (let c = 0; c < revealCount; c++) {
      n.cardsHost.append(faceUp ? cardElement(p.cards[c]) : cardElement(null, { faceDown: true }));
    }
    if (this.role === 'banker' && !p.opened) {
      n.totalEl.textContent = '';
      n.resultEl.textContent = '';
      n.resultEl.className = 'bj-box__result';
    } else {
      n.totalEl.textContent = seatHandLabel(p);
      n.resultEl.textContent = p.opened ? `${seatResultLabel(p)} ${p.payout >= 0 ? '+' : '−'}${formatChips(Math.abs(p.payout))}` : '';
      n.resultEl.className = p.opened ? `bj-box__result ${resultClass(p)}` : 'bj-box__result';
    }
  }

  /** The banker's own box. As banker, it's the human's hand — always fully
   * visible. As a bot, card 0 is up and card 1 is a hidden hole card (the
   * same rule American's single dealer follows) until the banker's own turn
   * begins (mBankerRevealed, flipped by flipMBankerHole()). */
  paintMBanker() {
    const n = this.mnodes.banker;
    const banker = this.mround?.banker;
    const isYou = this.role === 'banker';
    n.box.classList.toggle('bj-box--you', isYou);
    n.nameEl.textContent = isYou ? 'You' : 'Banker';
    if (!banker) { clear(n.cardsHost); n.totalEl.textContent = ''; return; }
    const revealed = isYou || this.mBankerRevealed;
    const shown = revealed ? banker.cards.length : Math.min(2, banker.cards.length);
    clear(n.cardsHost);
    for (let i = 0; i < shown; i++) {
      if (i === 1 && !revealed) n.cardsHost.append(el('div.bj-flip', cardElement(null, { faceDown: true })));
      else n.cardsHost.append(cardElement(banker.cards[i]));
    }
    n.totalEl.textContent = revealed ? this.mBankerLabel() : '';
  }

  mBankerLabel() {
    const t = malaysianTotal(this.mround.banker.cards);
    if (t.bust) return 'Bust';
    if (this.mround.banker.special === 'banban') return 'Ban Ban';
    if (this.mround.banker.special === 'banluck') return 'Ban Luck';
    return t.soft ? `Soft ${t.total}` : `${t.total}`;
  }

  highlightActiveMSeat(i) {
    this.mnodes.seats.forEach((s, idx) => s.box.classList.toggle('is-active', idx === i));
  }

  clearMSeatHighlights() {
    this.mnodes.seats.forEach((s) => s.box.classList.remove('is-active'));
  }

  /** Drives seats in order: a bot's whole turn resolves and animates in one
   * go, then the loop moves on by itself; reaching the human's own turn
   * pauses here and paints their controls instead. Once every seat is done,
   * hands off to the banker's turn (human-interactive or bot-scripted). */
  async advanceMTurns() {
    while (this.mround.phase === 'players') {
      const i = this.mround.activeSeat;
      const p = this.mround.players[i];
      this.highlightActiveMSeat(i);
      if (p.isHuman) {
        this.paintMActions();
        return;
      }
      MY.playSeatTurn(this.mround, i, this.mDeck, this.rng);
      await this.animateMSeatTurn(i);
      if (this.stopped) return;
      this.paintMHud();
    }
    this.clearMSeatHighlights();
    if (this.mround.settled) { this.finishMRound(); return; }
    await this.startMBankerPhase();
  }

  /** A bot seat's turn is already fully resolved (playSeatTurn ran
   * synchronously) — this just paces revealing it, ~700ms per logged
   * action, same pacing spec calls for. */
  async animateMSeatTurn(i) {
    const p = this.mround.players[i];
    if (!this.animationsOn()) { this.paintMSeat(i); return; }
    let count = 2;
    for (const action of p.actions) {
      await wait(SEAT_PACE_MS);
      if (this.stopped) return;
      if (action === 'hit') {
        count += 1;
        this.paintMSeat(i, { revealCount: count });
        this.pulseCard(this.mnodes.seats[i].cardsHost.lastElementChild);
      }
    }
    if (this.stopped) return;
    this.paintMSeat(i);
  }

  // --- the human's own seat turn -------------------------------------------

  /** Common tail for the human's own run/hit/stand: repaint, then only
   * resume the turn-advancing loop once their seat is actually done — a hit
   * that stays under 16 (or short of five cards) leaves them exactly where
   * they were, waiting for another action. */
  async afterMHumanAction(i) {
    this.paintMActions();
    const p = this.mround.players[i];
    if (!p || p.opened || p.busted || p.stood) {
      this.clearMSeatHighlights();
      await this.advanceMTurns();
    }
  }

  onMRun() {
    const i = this.mround.activeSeat;
    MY.runSeat(this.mround, i);
    this.paintMSeat(i);
    this.afterMHumanAction(i);
  }

  onMHit() {
    const i = this.mround.activeSeat;
    MY.hitSeat(this.mround, i, this.mDeck);
    this.paintMSeat(i);
    this.pulseCard(this.mnodes.seats[i].cardsHost.lastElementChild);
    this.afterMHumanAction(i);
  }

  onMStand() {
    const i = this.mround.activeSeat;
    MY.standSeat(this.mround, i);
    this.paintMSeat(i);
    this.afterMHumanAction(i);
  }

  // --- the banker's turn -----------------------------------------------------

  /** A human banker gets Hit + tap-to-open, exactly as the old dealer seat
   * did. A bot banker reveals its hole card (the same technique as
   * American's flipHoleCard) and then plays a fixed policy one action per
   * bankerBotStep() call, paced ~700ms, painting only what changed. */
  async startMBankerPhase() {
    this.paintMActions();
    if (this.role === 'banker') {
      this.enableOpenableMSeats();
      return;
    }
    await this.flipMBankerHole();
    if (this.stopped) return;
    while (this.mround.phase === 'banker' && !this.mround.settled) {
      const step = MY.bankerBotStep(this.mround, this.mDeck, this.rng);
      if (step.type === 'done') break;
      await wait(BANKER_PACE_MS);
      if (this.stopped) return;
      if (step.type === 'hit') {
        this.paintMBanker();
        this.pulseCard(this.mnodes.banker.cardsHost.lastElementChild);
      } else if (step.type === 'open') {
        this.paintMSeat(step.seatIndex);
        this.flashMSeat(step.seatIndex);
      }
      this.paintMHud();
    }
    if (this.stopped) return;
    this.finishMRound();
  }

  /** Flip the banker's hole card face up — a transform-only scaleX flip
   * with the face swapped in JS at the midpoint, the same technique as
   * American's flipHoleCard, just against Malaysian's own nodes. */
  async flipMBankerHole() {
    const n = this.mnodes.banker;
    this.mBankerRevealed = true;
    const wrap = n.cardsHost.children[1];
    if (!this.animationsOn() || !wrap || !wrap.classList.contains('bj-flip')) {
      this.paintMBanker();
      return;
    }
    wrap.classList.add('is-flipping');
    await wait(FLIP_MS / 2);
    if (this.stopped) return;
    clear(wrap);
    wrap.append(cardElement(this.mround.banker.cards[1]));
    await wait(FLIP_MS / 2);
    if (this.stopped) return;
    wrap.classList.remove('is-flipping');
    n.totalEl.textContent = this.mBankerLabel();
  }

  /** A brief highlight on the seat an opening just settled — border/shadow
   * only (the same transition .bj-box already carries for is-active/
   * is-openable), not a layout property, so it never causes a reflow. */
  flashMSeat(i) {
    const box = this.mnodes.seats[i].box;
    box.classList.add('is-active');
    setTimeout(() => box.classList.remove('is-active'), 500);
  }

  async onMBankerHit() {
    if (!MY.canBankerHit(this.mround)) return;
    MY.bankerHit(this.mround, this.mDeck);
    this.paintMBanker();
    this.pulseCard(this.mnodes.banker.cardsHost.lastElementChild);
    this.paintMHud();
    if (this.mround.settled) {
      this.paintMAll();
      this.finishMRound();
      return;
    }
    this.enableOpenableMSeats();
    this.paintMActions();
  }

  enableOpenableMSeats() {
    for (let i = 0; i < 4; i++) {
      const p = this.mround.players[i];
      const s = this.mnodes.seats[i];
      if (!p || p.opened) continue;
      const openable = MY.canOpenSeat(this.mround, i);
      s.box.disabled = !openable;
      s.box.classList.toggle('is-openable', openable);
      s.box.onclick = openable ? () => this.onMOpenSeat(i) : null;
    }
  }

  async onMOpenSeat(i) {
    if (!MY.canOpenSeat(this.mround, i)) return;
    const epoch = this.mEpoch;
    const s = this.mnodes.seats[i];
    const p = this.mround.players[i];
    s.box.disabled = true;
    s.box.classList.remove('is-openable');
    if (this.role === 'banker') {
      // Face down until now — flip each card, same technique as the
      // player-seat table's own hole-card flip.
      clear(s.cardsHost);
      const wraps = p.cards.map(() => el('div.bj-flip', cardElement(null, { faceDown: true })));
      wraps.forEach((w) => s.cardsHost.append(w));
      if (this.animationsOn()) {
        for (let c = 0; c < wraps.length; c++) {
          if (c > 0) await wait(120);
          if (this.stopped || this.mEpoch !== epoch) return;
          wraps[c].classList.add('is-flipping');
          await wait(FLIP_MS / 2);
          if (this.stopped || this.mEpoch !== epoch) return;
          clear(wraps[c]);
          wraps[c].append(cardElement(p.cards[c]));
          await wait(FLIP_MS / 2);
          if (this.stopped || this.mEpoch !== epoch) return;
          wraps[c].classList.remove('is-flipping');
        }
      } else {
        wraps.forEach((wrap, c) => { clear(wrap); wrap.append(cardElement(p.cards[c])); });
      }
    }
    // Same staleness check, one last time: a bulk auto-settle (the banker's
    // own Hit busting mid-flip) or a swap can both resolve this round while
    // the flip above was still running. Either way the table has moved on,
    // so committing this seat's own open now would repaint over whatever the
    // table is showing next (a fresh idle table or a fresh deal).
    if (this.stopped || this.mEpoch !== epoch) return;
    // As a player, this seat's cards were already face up throughout — an
    // opening here is purely a settlement, so there is nothing to flip.
    MY.openSeat(this.mround, i);
    this.paintMSeat(i);
    this.paintMHud();
    if (this.mround.settled) { this.finishMRound(); return; }
    this.enableOpenableMSeats();
  }

  // --- settlement ----------------------------------------------------------

  finishMRound() {
    const net = MY.tableRoundNet(this.mround);
    recordBlackjackResult(this.app.profile, 'blackjack', net);
    this.mFinished = true;
    this.mSettledAt = performance.now();
    this.clearMSeatHighlights();
    // Every seat can resolve at the deal itself (specials, every bot Run) and
    // never reach the banker's own turn — startMBankerPhase()/flipMBankerHole
    // then never run, and a bot banker's hole card would stay hidden even
    // though the round is over. Force it face up here so the final hand is
    // always fully visible, banker included, whichever way the round ended.
    if (!this.mBankerRevealed) {
      this.mBankerRevealed = true;
      this.paintMBanker();
    }
    // Every hand — the banker's included — stays on the table exactly as it
    // finished until Deal, Swap or a bot toggle changes it: the player has
    // to be able to see why they won or lost, not just the delta.
    this.showMBanner(net);
    this.paintMSettled();
    this.paintMActions();
  }

  /** YOUR result specifically (spec: "the result banner shows YOUR
   * result") — as banker that is the aggregate house result, same as the
   * old dealer seat; as a player it is your own seat's own outcome. */
  mResultTitle(net, push) {
    if (this.role === 'banker') return push ? 'Push' : net > 0 ? 'You win' : 'You lose';
    const p = this.mround.players.find((pp) => pp && pp.isHuman);
    if (p) {
      const banker = this.mround.banker;
      switch (p.result) {
        case 'banban': return 'Ban Ban!';
        case 'banluck': return 'Ban Luck!';
        case '777': return '777!';
        case 'five-dragon': return 'Five Dragon!';
        case 'run': return 'Run — push';
        case 'lose':
          if (p.busted) return 'Bust';
          if (banker.special === 'banban') return 'Banker Ban Ban';
          if (banker.special === 'banluck') return 'Banker Ban Luck';
          return 'You lose';
        case 'win': return 'You win';
        case 'push':
          if (banker.special === 'banban') return 'Push — Ban Ban';
          if (banker.special === 'banluck') return 'Push — Ban Luck';
          return 'Push';
        default: break;
      }
    }
    return push ? 'Push' : net > 0 ? 'You win' : 'You lose';
  }

  /** The result joins the swap button in its own row (.bj-midrow), between
   * the banker box and the seat row, instead of floating an absolutely
   * positioned overlay over a measured gap — an earlier version of this
   * measured the gap and clamped the banner into it, which could still push
   * it into the banker box or the seat row when the gap was the tighter of
   * the two; a version after that replaced swap outright, which fixed the
   * overlap but also made swap untappable for the entire between-rounds
   * window — the one time the player actually needs it, per the spec: swap
   * (and every bot toggle) has to keep working the instant a round settles,
   * without needing to deal again first. Sitting the two side by side in
   * one flex row (gap >=8px) keeps the banner clear of swap, the banker box
   * and the seat row by construction, and leaves swap fully live throughout.
   * restoreSwapSlot() removes the banner once Deal, Swap or a bot toggle
   * moves the table on. */
  showMBanner(net) {
    const win = net > 0;
    const push = net === 0;
    const cls = win ? 'is-win' : push ? 'is-push' : 'is-loss';
    const title = this.mResultTitle(net, push);
    const banner = el('div.bj-banner.bj-banner--inline', { class: cls },
      el('div.bj-banner__main', el('span.bj-banner__title', title), el('span.bj-banner__delta', `${net >= 0 ? '+' : '−'}${formatChips(Math.abs(net))}`)),
    );
    const n = this.mnodes;
    this.restoreSwapSlot(); // never two banners stacked, if this is ever called twice running
    n.midRow.append(banner);
    n.bannerEl = banner;
    requestAnimationFrame(() => banner.classList.add('is-on'));
  }

  /** Removes the result banner from swap's row once it no longer needs to
   * be there — called at the top of every repaint that moves the table on
   * from "just settled" (a fresh deal, or the true idle view after Swap or
   * a bot toggle). A no-op the rest of the time. */
  restoreSwapSlot() {
    const n = this.mnodes;
    if (n.bannerEl) { n.bannerEl.remove(); n.bannerEl = null; }
  }
}

/** A seat's hand, read the way a player at the table would say it out loud —
 * independent of seatResultLabel's win/lose/push framing below it, which is
 * about the payout, not what is actually in the hand. */
function seatHandLabel(p) {
  if (p.result === '777') return '777';
  if (p.result === 'five-dragon') return 'Five Dragon';
  if (p.special === 'banluck') return 'Ban Luck';
  if (p.special === 'banban') return 'Ban Ban';
  const { total } = malaysianTotal(p.cards);
  return p.busted ? `Bust ${total}` : `${total}`;
}

/** A seat's short result label once opened — a bust says so, even though the
 * engine settles it as a plain lose/push, since "Bust" is more informative
 * than "Lose" for a hand that never got compared to a total. */
function seatResultLabel(p) {
  if (p.busted) return p.result === 'push' ? 'Bust — push' : 'Bust';
  switch (p.result) {
    case 'run': return 'Run — push';
    case 'banban': return 'Ban Ban';
    case 'banluck': return 'Ban Luck';
    case '777': return '777';
    case 'five-dragon': return 'Five Dragon';
    case 'win': return 'Win';
    case 'lose': return 'Lose';
    case 'push': return 'Push';
    default: return '';
  }
}

function resultClass(p) {
  return p.payout > 0 ? 'is-win' : p.payout < 0 ? 'is-lose' : 'is-push';
}

function resultText(hand) {
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
