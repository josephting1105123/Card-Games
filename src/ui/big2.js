/**
 * Big Two table: single player against three bots.
 *
 * Structurally this mirrors solo.js + tableview.js (drive the engine, render
 * a seat view), kept as one file/one class pair because this table owns no
 * other file and there is nothing here a second screen would ever import.
 * games/big2/* is a different shape from Dou Di Zhu's (four seats, no
 * bidding, no bottom, no multiplier), so nothing is inherited from
 * tableview.js — the DOM/CSS structure below is new, the *visual* language
 * (felt, seat plates, floating controls pill, played-card zones) is carried
 * over on purpose so the two tables read as the same app.
 */

import { RESCUE_EXIT, formatChips, lobbyAccess, settleBigTwo } from '../core/economy.js';
import { ratingTitle } from '../core/elo.js';
import { gameStats, recordResult } from '../core/profile.js';
import { makeRng, randomSeed } from '../core/rng.js';
import { SEATS, HAND_SIZE, Phase, canPass, createGame, pass, play, seatView, settle } from '../games/big2/engine.js';
import { skillByName } from '../games/big2/ai.js';
import { botTurn } from '../games/big2/match.js';
import { beats, classify, comboName, describeCombo, cardValue, SUIT_ORDER } from '../games/big2/rules.js';
import { findHints } from '../games/big2/moves.js';
import { cardElement, installCardDefs } from './cardart.js';
import { announce, clear, el, wait } from './dom.js';
import { enableTableFullscreen } from './fullscreen.js';

const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui', 'Qiao', 'Rong'];

function sortHand(hand, mode) {
  return mode === 'suit'
    ? [...hand].sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.rank - b.rank)
    : [...hand].sort((a, b) => cardValue(a) - cardValue(b));
}

/** "Pair" — short enough to sit under a play without shouting; see describeCombo for the long form. */
function shortName(combo) {
  return combo ? comboName(combo.type) : '';
}

export class BigTwoGame {
  /**
   * @param {object} app the app context from main.js
   * @param {{lobby: object, gameId: string}} options
   */
  constructor(app, { lobby, gameId = 'big2' }) {
    this.app = app;
    this.lobby = lobby;
    this.gameId = gameId;
    this.skill = skillByName(lobby.skill);
    this.rate = lobby.pot / 10; // F1: rate = lobby.pot / 10, no multipliers
    this.busy = false;
  }

  mount(root) {
    this.root = root;
    this.view = new Big2View({
      root,
      meta: {
        lobbyName: this.lobby.name,
        rateLabel: `Per card ${formatChips(this.rate, true)}`,
        bankroll: this.app.profile.bankroll,
        animations: this.app.profile.settings?.animations !== false,
      },
      handlers: {
        onPlay: (cards) => this.onPlay(cards),
        onPass: () => this.onPass(),
        onLeave: () => this.app.go('menu'),
      },
    });
    this.newDeal();
    this.onResize = () => this.view?.renderHand();
    globalThis.addEventListener('resize', this.onResize);
  }

  unmount() {
    globalThis.removeEventListener('resize', this.onResize);
    this.stopped = true;
  }

  newDeal() {
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, SEATS - 1);
    this.seed = randomSeed();
    this.rng = makeRng(`${this.seed}:bots`);
    this.state = createGame({
      seed: this.seed,
      players: [
        { name: this.app.profile.name || 'You', isHuman: true },
        { name: names[0], isHuman: false, skill: this.skill },
        { name: names[1], isHuman: false, skill: this.skill },
        { name: names[2], isHuman: false, skill: this.skill },
      ],
    });
    this.settled = false;
    this.view.resetTrick();
    this.refresh();
    this.view.dealIn().then(() => {
      if (!this.stopped) this.drive();
    });
  }

  refresh() {
    const view = seatView(this.state, 0);
    if (this.state.phase === Phase.FINISHED) view.revealedHands = this.state.hands;
    this.view.update(view);
  }

  /** Let the bots act until it is the human's turn or the hand is over. */
  async drive() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.state.phase !== Phase.FINISHED && this.state.turn !== 0) {
        await wait(this.app.profile.settings?.animations === false ? 60 : 700 + Math.random() * 400);
        if (this.stopped) return;
        // Captured before the mutation: play() always leaves state.trick set
        // (even on the play that empties a hand), so "was this seat leading"
        // has to be read before botTurn runs, not after.
        const leadingBefore = !this.state.trick;
        const acted = botTurn(this.state, this.rng);
        if (!acted) break;
        this.reportAction(acted, leadingBefore);
        this.refresh();
      }
    } finally {
      this.busy = false;
    }
    if (this.state.phase === Phase.FINISHED) this.settle();
    else this.refresh();
  }

  /** Feed the view's per-trick display straight from what just happened, in order. */
  reportAction(acted, leadingBefore) {
    if (acted.kind === 'play') {
      this.view.recordPlay(acted.seat, classify(acted.cards), leadingBefore);
      return;
    }
    if (acted.kind === 'pass') {
      this.view.recordPass(acted.seat, this.state.trick === null);
      return;
    }
    // 'fallback': the ai proposed an illegal move (should not happen — both it
    // and the engine read the same rules.js) and match.js played safe instead.
    // Resync the felt from state rather than guess what that fallback did.
    this.view.resetTrick();
  }

  onPlay(cards) {
    if (this.state.turn !== 0) return;
    const wasLeading = !this.state.trick;
    const res = play(this.state, 0, cards);
    if (!res.ok) {
      announce(res.error);
      this.view.flashError(res.error);
      return;
    }
    this.view.recordPlay(0, classify(cards), wasLeading);
    this.view.selected.clear();
    this.refresh();
    if (this.state.phase !== Phase.FINISHED) this.drive();
    else this.settle();
  }

  onPass() {
    if (this.state.turn !== 0 || !canPass(this.state, 0)) return;
    const res = pass(this.state, 0);
    if (!res.ok) {
      announce(res.error);
      return;
    }
    this.view.recordPass(0, this.state.trick === null);
    this.refresh();
    this.drive();
  }

  settle() {
    if (this.settled) return;
    this.settled = true;
    const profile = this.app.profile;
    const rescueMode = profile.rescueMode;
    const { payouts, cardsLeft } = settle(this.state, this.rate);
    const settlement = settleBigTwo({ lobby: this.lobby, gross: payouts[0], bankroll: profile.bankroll, rescueMode });
    const before = gameStats(profile, this.gameId).rating;
    const { elo, bankrollChange } = recordResult(profile, {
      gameId: this.gameId,
      delta: settlement.delta,
      won: settlement.won,
      botElo: this.lobby.botElo,
    });
    this.view.setBankroll(profile.bankroll);
    this.app.refreshChrome?.();

    const names = this.state.players.map((p) => p.name);
    const rows = this.state.players.map((p, seat) => ({
      name: seat === 0 ? `${p.name} (you)` : p.name,
      cardsLeft: cardsLeft[seat],
      delta: seat === 0 ? settlement.delta : payouts[seat],
      isWinner: seat === this.state.winner,
    }));

    // Short landscape (the same 460px threshold big2.css's compact result
    // layout switches on) has no room for Elo and Chips as two lines, so
    // they're combined into one here rather than left to CSS to arrange —
    // reliable regardless of how many other lines (capped/bankrupt/rescue)
    // end up between them.
    const compact = globalThis.matchMedia?.('(orientation: landscape) and (max-height: 460px)')?.matches;
    const lines = [
      `Winner: <span>${names[this.state.winner]}</span>${this.state.winner === 0 ? ' — you went out first' : ''}`,
      `Rate: <span>${formatChips(this.rate)}</span> per card left`,
      compact
        ? `Elo <span>${before} → ${elo.rating}</span> (${elo.delta >= 0 ? '+' : ''}${elo.delta}) · Chips <span>${formatChips(profile.bankroll)}</span>`
        : `Elo: <span>${before} → ${elo.rating}</span> (${elo.delta >= 0 ? '+' : ''}${elo.delta}, ${ratingTitle(elo.rating)})`,
    ];
    if (!compact) lines.push(`Chips: <span>${formatChips(profile.bankroll)}</span>`);
    if (settlement.capped) {
      lines.splice(2, 0, `Loss capped at <span>${formatChips(Math.abs(settlement.delta))}</span> (gross ${formatChips(Math.abs(settlement.gross))})`);
    }
    if (bankrollChange.wentBankrupt) {
      lines.push(`<span>Bankrupt.</span> You have been moved to the rescue table: 400 pot, no bankruptcy, until you hold <span>${formatChips(RESCUE_EXIT)}</span>.`);
    }
    if (bankrollChange.leftRescue) {
      lines.push('<span>Back in the game.</span> The normal tables are open again.');
    }

    const access = lobbyAccess(profile.bankroll, profile.rescueMode).find((a) => a.lobby.id === this.lobby.id);
    const canRepeat = access && !access.locked;
    if (!canRepeat) lines.push(`You can no longer sit at this table: <span>${access?.reason ?? 'not available'}</span>`);

    this.view.showResult({
      title: settlement.won ? 'You win' : 'You lose',
      win: settlement.won,
      deltaText: `${settlement.delta >= 0 ? '+' : '−'}${formatChips(Math.abs(settlement.delta))}`,
      rows,
      lines,
      againLabel: canRepeat ? 'Next hand' : 'Choose another table',
      onAgain: () => (canRepeat ? this.newDeal() : this.app.go('lobby', { gameId: this.gameId })),
      onLeave: () => this.app.go('menu'),
    });
  }
}

class Big2View {
  constructor({ root, meta, handlers }) {
    installCardDefs();
    this.root = root;
    this.meta = meta;
    this.handlers = handlers;
    this.selected = new Set();
    this.sortMode = 'rank';
    this.trickEntries = new Map(); // seat -> {pass:true} | {combo,cards}
    this.trickToken = 0;
    this.trickFading = false;
    this.hintSignature = null;
    this.hintIndex = -1;
    this.build();
  }

  build() {
    clear(this.root);
    const n = this.nodes = {};

    n.bankPill = el('span.b2-hud__pill', el('small', 'Chips'), el('b', formatChips(this.meta.bankroll ?? 0)));
    const hud = el('div.b2-hud',
      el('button.back-link', { type: 'button', 'aria-label': 'Leave table', title: 'Leave table', onclick: () => this.handlers.onLeave?.() }, '←'),
      el('span.b2-hud__pill.b2-hud__pill--table', el('b', this.meta.lobbyName), el('small', this.meta.rateLabel)),
      el('div.b2-hud__spacer'),
      n.bankPill,
    );

    n.seatTop = this.buildSeat('top');
    n.seatLeft = this.buildSeat('left');
    n.seatRight = this.buildSeat('right');

    const playZone = (slot) => el(`div.b2-play.b2-play--${slot}`, el('div.b2-play__cards'), el('span.b2-play__name'));
    n.plays = { top: playZone('top'), left: playZone('left'), right: playZone('right'), self: playZone('self') };

    n.sortBtn = el('button.btn', { type: 'button', onclick: () => this.toggleSort() }, 'Sort: Rank');
    n.hintBtn = el('button.btn', { type: 'button', onclick: () => this.showHint() }, 'Hint');
    n.passBtn = el('button.btn', { type: 'button', onclick: () => this.handlers.onPass?.() }, 'Pass');
    n.playBtn = el('button.btn.btn--primary', { type: 'button', onclick: () => this.playSelection() }, 'Play');
    // F4's "Your lead — include 3♦" line and the ordinary selection feedback
    // never apply at the same time (the first only shows before you have
    // selected anything), so both share this one label rather than needing a
    // second spot on an already-crowded felt — see renderControls().
    n.comboLabel = el('span.b2-controls__label', '');
    n.controls = el('div.b2-controls', n.sortBtn, n.hintBtn, n.passBtn, n.playBtn, n.comboLabel);

    // Order matters here: seatTop, playTop, the spacer, playSelf and controls
    // are real flow children (see .b2-felt in big2.css) — the spacer between
    // playTop and playSelf is what keeps the two apart, not a percentage.
    // seatLeft/seatRight/playLeft/playRight stay position:absolute, so their
    // place in this list is cosmetic.
    n.spacer = el('div.b2-spacer');
    n.felt = el('div.b2-felt',
      n.seatTop.wrap, n.plays.top, n.spacer, n.plays.self, n.controls,
      n.seatLeft.wrap, n.seatRight.wrap, n.plays.left, n.plays.right);

    n.handInner = el('div.b2-hand__inner');
    n.hand = el('div.b2-hand', n.handInner);
    n.dock = el('div.b2-dock', n.hand);

    n.table = el('div.b2-table', hud, n.felt, n.dock);
    n.table.addEventListener('scroll', () => { n.table.scrollTop = 0; n.table.scrollLeft = 0; });

    this.root.append(
      n.table,
      el('div.b2-rotate-gate',
        el('div',
          el('div.b2-rotate-gate__icon', '↻'),
          el('h2', 'Turn your device'),
          el('p', 'Big Two is dealt across the table. Landscape gives the fan room to breathe.'),
        ),
      ),
    );
    this.teardownFullscreen = enableTableFullscreen(n.table, hud);
  }

  buildSeat(side) {
    const avatar = el('span.b2-seat__avatar', '?');
    const name = el('span.b2-seat__name', '—');
    const count = el('span.b2-seat__count', '13');
    const plate = el('div.b2-seat__plate', avatar, name, count);
    const backs = el('div.b2-seat__backs');
    const wrap = el(`div.b2-seat.b2-seat--${side}`, plate, backs);
    return { wrap, avatar, name, count, plate, backs };
  }

  /** Replace the whole displayed state. */
  update(view) {
    this.view = view;
    const handIds = new Set(view.you.hand.map((c) => c.id));
    for (const id of [...this.selected]) if (!handIds.has(id)) this.selected.delete(id);

    this.renderSeats();
    this.renderPlays();
    this.renderHand();
    this.renderControls();
    this.renderHud();
  }

  setBankroll(value) {
    this.meta.bankroll = value;
    this.nodes.bankPill.querySelector('b').textContent = formatChips(value);
  }

  renderHud() {
    // Nothing dynamic beyond the purse today, but kept as its own pass (like
    // tableview.js's renderHud) so a future addition has somewhere to live
    // without reshuffling update()'s call order.
  }

  /** Which seat sits in each of the three opponent slots, from here. */
  seatForSlot(slot) {
    const me = this.view.seat;
    if (slot === 'self') return me;
    if (slot === 'right') return (me + 1) % SEATS;
    if (slot === 'top') return (me + 2) % SEATS;
    return (me + 3) % SEATS; // left
  }

  renderSeats() {
    const view = this.view;
    const finished = view.phase === Phase.FINISHED;
    for (const [slot, node] of [['top', this.nodes.seatTop], ['left', this.nodes.seatLeft], ['right', this.nodes.seatRight]]) {
      const seat = this.seatForSlot(slot);
      const player = view.players[seat];
      node.name.textContent = player.name;
      node.avatar.textContent = player.name.slice(0, 1).toUpperCase();
      node.plate.classList.toggle('is-turn', seat === view.turn && !finished);
      node.count.textContent = `${player.cards}`;
      // Rose-gold, tokens only: the one hand a follower most needs to notice.
      node.count.classList.toggle('is-last-card', player.cards === 1 && !finished);

      if (finished && view.revealedHands) {
        const signature = `reveal:${view.revealedHands[seat].map((c) => c.id).join(',')}`;
        if (node.backs.dataset.key !== signature) {
          node.backs.dataset.key = signature;
          clear(node.backs);
          node.backs.classList.add('is-revealed');
          for (const card of sortHand(view.revealedHands[seat], 'rank')) node.backs.append(cardElement(card));
        }
        continue;
      }
      node.backs.classList.remove('is-revealed');
      const shown = Math.min(player.cards, HAND_SIZE);
      const signature = `backs:${shown}`;
      if (node.backs.dataset.key !== signature) {
        node.backs.dataset.key = signature;
        clear(node.backs);
        for (let i = 0; i < shown; i++) node.backs.append(cardElement(null, { faceDown: true }));
      }
    }
  }

  /** Record what a seat just did in the trick now on the felt. Called by the
   * controller in the exact order actions happen, so the felt never has to
   * reconstruct "who did what" from the engine's flat history log. */
  recordPlay(seat, combo, wasLeading) {
    if (wasLeading) this.resetTrick();
    this.trickEntries.set(seat, { pass: false, combo });
    this.renderPlays();
  }

  recordPass(seat, resolvedTrick) {
    this.trickEntries.set(seat, { pass: true });
    this.renderPlays();
    // F4: the trick stays up until three passes, then clears — opacity out
    // 300ms, starting 500ms after the third pass. Scheduled here rather than
    // left to whatever renders next, so it happens even if nobody acts for a
    // while (a bot's own next thinking delay is comfortably longer than
    // 800ms, but the human's is not bounded at all).
    if (resolvedTrick) this.scheduleTrickClear();
  }

  resetTrick() {
    this.trickEntries.clear();
    this.trickToken += 1; // invalidates any fade already in flight
    this.trickFading = false;
  }

  async scheduleTrickClear() {
    const token = ++this.trickToken;
    await wait(500);
    if (token !== this.trickToken) return;
    this.trickFading = true;
    this.renderPlays();
    await wait(300);
    if (token !== this.trickToken) return;
    this.trickEntries.clear();
    this.trickFading = false;
    this.renderPlays();
  }

  renderPlays() {
    const view = this.view;
    for (const slot of ['top', 'left', 'right', 'self']) {
      const zone = this.nodes.plays[slot];
      const seat = this.seatForSlot(slot);
      const entry = this.trickEntries.get(seat);
      const key = entry ? (entry.pass ? 'pass' : entry.combo.cards.map((c) => c.id).join(',')) : '';
      if (zone.dataset.key !== key) {
        zone.dataset.key = key;
        this.paintZone(zone, entry, slot);
      }
      zone.classList.toggle('is-empty', !entry);
      zone.classList.toggle('is-fading', this.trickFading);
      zone.querySelector('.b2-play__name').textContent = entry ? (entry.pass ? 'Pass' : shortName(entry.combo)) : '';
    }
  }

  paintZone(zone, entry, slot) {
    const cards = zone.querySelector('.b2-play__cards');
    clear(cards);
    zone.classList.remove('is-entering');
    if (!entry || entry.pass) return;
    sortHand(entry.combo.cards, 'rank').forEach((card, index) => {
      const node = cardElement(card);
      node.style.setProperty('--i', String(index));
      cards.append(node);
    });
    void zone.offsetWidth;
    zone.classList.add('is-entering');
    const view = this.view;
    const seat = this.seatForSlot(slot);
    const who = seat === view.seat ? 'You' : view.players[seat]?.name ?? 'Opponent';
    announce(`${who} played ${describeCombo(entry.combo)}`);
  }

  /** True only before the very first play of the whole hand, on your turn. */
  isFirstLeadPending() {
    const view = this.view;
    return view.phase === Phase.PLAYING && view.turn === view.seat && !view.trick && view.leadMustInclude != null;
  }

  renderHand() {
    const view = this.view;
    const hand = sortHand(view.you.hand, this.sortMode);
    const signature = [
      hand.map((c) => c.id).join(','),
      [...this.selected].sort().join(','),
      this.root.clientWidth, this.root.clientHeight,
    ].join('|');
    if (signature === this.handSignature) return;
    this.handSignature = signature;

    const inner = this.nodes.handInner;
    clear(inner);
    const width = this.cardWidth();
    const available = this.root.clientWidth * 0.94;
    const step = hand.length > 1 ? Math.min(width * 0.5, (available - width) / (hand.length - 1)) : 0;
    inner.style.width = `${width + step * Math.max(0, hand.length - 1)}px`;
    inner.style.setProperty('--step', `${step}px`);

    hand.forEach((card, index) => {
      const node = cardElement(card, { selectable: true });
      node.style.setProperty('--i', String(index));
      node.classList.toggle('is-selected', this.selected.has(card.id));
      node.setAttribute('aria-pressed', this.selected.has(card.id) ? 'true' : 'false');
      node.addEventListener('click', () => this.toggle(card.id));
      inner.append(node);
    });
  }

  cardWidth() {
    const probe = this.nodes.handInner.querySelector('.card');
    if (probe) return probe.getBoundingClientRect().width || 60;
    const vh = this.root.clientHeight || 390;
    return Math.min(120, Math.max(56, vh * 0.175));
  }

  toggle(cardId) {
    if (!this.isYourTurn()) return;
    if (this.selected.has(cardId)) this.selected.delete(cardId);
    else this.selected.add(cardId);
    this.renderHand();
    this.renderControls();
  }

  selectCards(cards) {
    this.selected = new Set(cards.map((c) => c.id));
    this.renderHand();
    this.renderControls();
  }

  isYourTurn() {
    return this.view?.phase === Phase.PLAYING && this.view.turn === this.view.seat;
  }

  selectionCards() {
    const byId = new Map(this.view.you.hand.map((c) => [c.id, c]));
    return [...this.selected].map((id) => byId.get(id)).filter(Boolean);
  }

  legalityOf(combo) {
    const view = this.view;
    if (!combo) return { legal: false };
    const current = view.trick?.combo ?? null;
    if (current) return { legal: beats(combo, current) };
    if (view.leadMustInclude != null && !combo.cards.some((c) => c.id === view.leadMustInclude)) {
      return { legal: false, needsThreeDiamond: true };
    }
    return { legal: true };
  }

  renderControls() {
    const view = this.view;
    const n = this.nodes;
    const yours = this.isYourTurn();
    const cards = this.selectionCards();
    const combo = cards.length ? classify(cards) : null;
    const { legal, needsThreeDiamond } = this.legalityOf(combo);

    n.sortBtn.textContent = `Sort: ${this.sortMode === 'rank' ? 'Rank' : 'Suit'}`;
    n.playBtn.disabled = !yours || !legal;
    n.passBtn.disabled = !yours || !view.trick;
    n.hintBtn.disabled = !yours;
    n.comboLabel.textContent = !cards.length
      ? (this.isFirstLeadPending() ? 'Your lead — include 3♦' : '')
      : legal ? describeCombo(combo)
      : needsThreeDiamond ? `${describeCombo(combo)} — must include 3♦`
      : combo ? `${describeCombo(combo)} — does not beat it`
      : 'Not a combination';
  }

  playSelection() {
    const cards = this.selectionCards();
    if (!classify(cards)) return;
    this.handlers.onPlay?.(cards);
  }

  flashError(message) {
    this.nodes.comboLabel.textContent = message;
  }

  showHint() {
    if (!this.isYourTurn()) return;
    const view = this.view;
    const current = view.trick?.combo ?? null;
    const hints = findHints(view.you.hand, current, { mustInclude: view.leadMustInclude });
    if (!hints.length) {
      announce('No legal play. You will have to pass.');
      this.nodes.comboLabel.textContent = 'Nothing beats that — pass';
      return;
    }
    const signature = `${view.turn}:${current?.key ?? 'lead'}:${current?.size ?? ''}`;
    if (signature !== this.hintSignature) {
      this.hintSignature = signature;
      this.hintIndex = 0;
    } else {
      this.hintIndex = (this.hintIndex + 1) % hints.length;
    }
    this.selectCards(hints[this.hintIndex].cards);
    announce(`Suggested: ${describeCombo(hints[this.hintIndex])}`);
  }

  toggleSort() {
    this.sortMode = this.sortMode === 'rank' ? 'suit' : 'rank';
    this.handSignature = null; // force a rebuild even though the card set is unchanged
    this.renderHand();
    this.renderControls();
  }

  /**
   * Deal: a face-down pile at the felt's centre sends 52 cards out
   * round-robin (you, right, top, left) one at a time — opponents' backs
   * tick up as flyers land, yours gather at the hand's centre instead of
   * their own eventual slots (their final rank/suit order is not known
   * until every card is in) and then, once the last one lands, fan out
   * together straight into the already-sorted real hand underneath. A
   * tap/click anywhere on the table skips to the end state; transform and
   * opacity only throughout (house rule).
   */
  async dealIn() {
    if (!this.animationsOn()) return;
    const view = this.view;
    const table = this.nodes.table;
    const felt = this.nodes.felt;
    const N = view.you.hand.length; // HAND_SIZE, pre-shuffle

    // Belt and suspenders alongside .is-dealing's own opacity:0/pointer-events:none
    // (see big2.css): disable every control outright rather than trust opacity
    // and hit-testing alone to keep an invisible button from taking a tap.
    // Each button's own disabled state (Sort is never disabled; Hint/Pass/Play
    // depend on whose turn the new hand opens on) is restored, not just reset
    // to enabled, once the deal lands.
    const controlButtons = [this.nodes.sortBtn, this.nodes.hintBtn, this.nodes.passBtn, this.nodes.playBtn];
    const priorDisabled = controlButtons.map((b) => b.disabled);
    for (const b of controlButtons) b.disabled = true;

    table.classList.add('is-dealing');

    let skipped = false;
    let resolveSkip;
    const skipPromise = new Promise((resolve) => { resolveSkip = resolve; });
    const onTap = () => { skipped = true; resolveSkip(); };
    table.addEventListener('pointerdown', onTap, { capture: true });
    const race = (ms) => Promise.race([wait(ms), skipPromise]);

    const dealer = el('div.b2-dealer');
    felt.append(dealer);
    const stack = el('div.b2-dealer__card');
    stack.append(cardElement(null, { faceDown: true }));
    dealer.append(stack);

    const finish = () => {
      table.removeEventListener('pointerdown', onTap, { capture: true });
      dealer.remove();
      table.classList.remove('is-dealing');
      controlButtons.forEach((b, i) => { b.disabled = priorDisabled[i]; });
      for (const seatNode of [this.nodes.seatTop, this.nodes.seatLeft, this.nodes.seatRight]) {
        for (const child of seatNode.backs.children) child.style.opacity = '';
      }
    };

    const anchor = dealer.getBoundingClientRect();
    const anchorX = anchor.left + anchor.width / 2;
    const anchorY = anchor.top + anchor.height / 2;
    const deckWidth = stack.getBoundingClientRect().width;
    const offsetOf = (rect) => ({ tx: rect.left + rect.width / 2 - anchorX, ty: rect.top + rect.height / 2 - anchorY });

    const handCards = [...this.nodes.handInner.children]; // real, hidden, already sorted
    const handWidth = (handCards[0] ?? this.nodes.handInner).getBoundingClientRect().width || deckWidth;
    const handRects = handCards.map((c) => c.getBoundingClientRect());
    const handRowRect = this.nodes.handInner.getBoundingClientRect();
    const gather = offsetOf({ left: handRowRect.left, width: handRowRect.width, top: handRowRect.top, height: handRowRect.height });

    const seatOrder = [
      { node: this.nodes.seatRight, key: 'right' },
      { node: this.nodes.seatTop, key: 'top' },
      { node: this.nodes.seatLeft, key: 'left' },
    ].map((s) => ({ ...s, children: [...s.node.backs.children], rects: [...s.node.backs.children].map((c) => c.getBoundingClientRect()) }));
    const backWidth = (seatOrder[0].children[0] ?? this.nodes.seatRight.backs).getBoundingClientRect().width || deckWidth;

    const STAGGER = 35;
    const FLIGHT = 210;
    const selfScale = handWidth / deckWidth;
    const backScale = backWidth / deckWidth;
    const gatherFlyers = [];
    let selfCount = 0;
    const opponentCounts = [0, 0, 0];

    const launchOpponent = (idx) => {
      const seat = seatOrder[idx];
      const slot = Math.min(opponentCounts[idx], seat.rects.length - 1);
      const flyer = cardElement(null, { faceDown: true });
      flyer.classList.add('b2-dealer__flyer');
      dealer.append(flyer);
      const { tx, ty } = offsetOf(seat.rects[slot]);
      flyTo(flyer, { tx, ty, ts: backScale, dur: FLIGHT });
      const revealAt = opponentCounts[idx];
      (async () => {
        await race(FLIGHT);
        if (revealAt < seat.children.length) seat.children[revealAt].style.opacity = '1';
        flyer.remove();
      })();
      opponentCounts[idx] += 1;
    };

    const order = [];
    for (let round = 0; round < N; round++) order.push('self', 'right', 'top', 'left');

    for (let i = 0; i < order.length; i++) {
      if (skipped) break;
      const seat = order[i];
      if (seat === 'self') {
        const slot = selfCount; selfCount++;
        const flyer = cardElement(view.you.hand[slot % view.you.hand.length], {});
        flyer.classList.add('b2-dealer__flyer');
        dealer.append(flyer);
        gatherFlyers.push(flyer);
        flyTo(flyer, { tx: gather.tx, ty: gather.ty, tr: -8, ts: selfScale, dur: FLIGHT });
      } else {
        launchOpponent(seat === 'right' ? 0 : seat === 'top' ? 1 : 2);
      }
      if (i < order.length - 1) await race(STAGGER);
    }
    if (!skipped) await race(FLIGHT);
    if (skipped) return finish();

    await race(150);
    if (skipped) return finish();

    // All 13 of your flyers sit stacked at the hand's centre; fan them out
    // together into the real, already-sorted hand underneath in one leg.
    for (let i = 0; i < gatherFlyers.length && i < handRects.length; i++) {
      const flyer = gatherFlyers[i];
      const { tx, ty } = offsetOf(handRects[i]);
      flyer.style.zIndex = String(i);
      flyTo(flyer, { fx: gather.tx, fy: gather.ty, fr: -8, fs: selfScale, tx, ty, tr: 0, ts: selfScale, dur: 280 });
    }
    if (!skipped) await race(280);
    finish();
  }

  animationsOn() {
    if (this.meta.animations === false) return false;
    return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  }

  /** Full-screen result card: every seat's cards left and chip change, bankroll after. */
  showResult({ title, win, deltaText, rows, lines, onAgain, onLeave, againLabel }) {
    const rowsEl = el('div.b2-result__rows',
      ...rows.map((r) => el('div', { class: `b2-result__row${r.isWinner ? ' is-winner' : ''}` },
        el('span.b2-result__name', r.name),
        el('span.b2-result__cards', `${r.cardsLeft} left`),
        el('span', { class: `b2-result__delta ${r.delta >= 0 ? 'is-win' : 'is-loss'}` },
          `${r.delta >= 0 ? '+' : '−'}${formatChips(Math.abs(r.delta))}`),
      )),
    );
    // Title and delta share one row (big2.css puts them side by side only
    // under the short-landscape query — the default, roomier sizes keep them
    // stacked as before).
    const head = el('div.b2-result__head',
      el('h2', { class: `b2-result__title ${win ? 'is-win' : 'is-loss'}` }, title),
      el('div', { class: `b2-result__big-delta ${win ? 'is-win' : 'is-loss'}` }, deltaText),
    );
    const nextBtn = el('button.btn.btn--primary', { type: 'button', onclick: (e) => { e.stopPropagation(); overlay.remove(); onAgain?.(); } }, againLabel);
    const leaveBtn = el('button.btn', { type: 'button', onclick: (e) => { e.stopPropagation(); overlay.remove(); onLeave?.(); } }, 'Leave');
    // F4: every hand is revealed face up in place, but the sheet and its
    // dimmed backdrop were sitting right on top of the seats — this toggle
    // collapses the card to a slim bar (result + Next hand) docked over the
    // HUD, which big2.css keeps clear of every seat plate and revealed card
    // at every viewport this table supports, and clears the backdrop so the
    // felt underneath is genuinely visible, not just technically undestroyed.
    const toggleBtn = el('button.b2-result__toggle', {
      type: 'button',
      onclick: (e) => { e.stopPropagation(); setCollapsed(!overlay.classList.contains('is-collapsed')); },
    }, 'Show table');
    const card = el('div.b2-result',
      head,
      rowsEl,
      el('ul.b2-result__lines', ...lines.map((line) => el('li', { html: line }))),
      el('div.btn-row', { style: 'justify-content:center' }, nextBtn, leaveBtn),
      toggleBtn,
    );
    const overlay = el('div.b2-overlay', card);
    function setCollapsed(collapsed) {
      overlay.classList.toggle('is-collapsed', collapsed);
      toggleBtn.textContent = collapsed ? 'Show result' : 'Show table';
    }
    // Tapping the collapsed bar anywhere restores the sheet; Next hand's own
    // handler already stops the click reaching here, so it still just plays
    // the next hand instead of re-expanding first.
    card.addEventListener('click', () => { if (overlay.classList.contains('is-collapsed')) setCollapsed(false); });
    this.root.append(overlay);
    return overlay;
  }

  destroy() {
    this.teardownFullscreen?.();
    clear(this.root);
  }
}

/** Run one flight leg: write the cg-fly-style custom properties, restart. */
function flyTo(card, p) {
  const set = (name, value, unit = '') => card.style.setProperty(name, `${value ?? 0}${unit}`);
  set('--fx', p.fx, 'px'); set('--fy', p.fy, 'px'); set('--fr', p.fr, 'deg');
  set('--fs', p.fs ?? 1); set('--fo', p.fo ?? 1);
  set('--tx', p.tx, 'px'); set('--ty', p.ty, 'px'); set('--tr', p.tr, 'deg');
  set('--ts', p.ts ?? 1); set('--to', p.to ?? 1);
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = `b2-fly ${p.dur}ms var(--ease) forwards`;
}
