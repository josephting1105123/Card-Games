/**
 * Single-player table: the local engine, two bots, and settlement against the
 * stored profile.
 *
 * The human always sits in seat 0. Bot skill and the chips at stake come from
 * the lobby, so "harder table" and "bigger pot" are the same choice.
 */

import { formatChips, lobbyAccess, settleDouDiZhu } from '../core/economy.js';
import { ratingTitle } from '../core/elo.js';
import { gameStats, recordResult } from '../core/profile.js';
import { makeRng, randomSeed } from '../core/rng.js';
import { Phase, bid, createGame, pass, play, seatView } from '../games/doudizhu/engine.js';
import { botTurn } from '../games/doudizhu/match.js';
import { SKILLS, skillByName } from '../games/doudizhu/ai.js';
import { describeCombo } from '../games/doudizhu/rules.js';
import { TableView } from './tableview.js';
import { announce, wait } from './dom.js';

const BOT_NAMES = ['Mei', 'Chen', 'Lin', 'Bao', 'Fang', 'Hui', 'Qiao', 'Rong'];

export class SoloGame {
  /**
   * @param {object} app  the app context from main.js
   * @param {{lobby: object, gameId: string}} options
   */
  constructor(app, { lobby, gameId = 'doudizhu' }) {
    this.app = app;
    this.lobby = lobby;
    this.gameId = gameId;
    this.skill = skillByName(lobby.skill);
    this.busy = false;
  }

  mount(root) {
    this.root = root;
    this.view = new TableView({
      root,
      meta: {
        lobbyName: `${this.lobby.name} · ${this.lobby.short}`,
        potLabel: formatChips(this.lobby.pot, true),
        bankroll: this.app.profile.bankroll,
        baseMultiplier: this.lobby.baseMultiplier,
      },
      handlers: {
        onBid: (value) => this.onBid(value),
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
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 2);
    this.seed = randomSeed();
    this.rng = makeRng(`${this.seed}:bots`);
    this.state = createGame({
      seed: this.seed,
      players: [
        { id: 'you', name: this.app.profile.name || 'You' },
        { id: 'bot1', name: `${names[0]} (${this.skill.name})`, isBot: true, skill: this.skill },
        { id: 'bot2', name: `${names[1]} (${this.skill.name})`, isBot: true, skill: this.skill },
      ],
    });
    this.settled = false;
    this.refresh();
    this.drive();
  }

  refresh() {
    this.view.update(seatView(this.state, 0));
  }

  /** Let the bots act until it is the human's turn or the deal is over. */
  async drive() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.stopped && this.state.phase !== Phase.FINISHED) {
        const isBidding = this.state.phase === Phase.BIDDING;
        const seat = isBidding ? this.state.bidding.turn : this.state.turn;
        if (seat === 0) break;
        await wait(this.app.profile.settings?.animations === false ? 60 : 480 + Math.random() * 320);
        if (this.stopped) return;
        const acted = botTurn(this.state, this.rng);
        if (!acted) break;
        this.reportBotAction(acted);
        this.refresh();
      }
    } finally {
      this.busy = false;
    }
    if (this.state.phase === Phase.FINISHED) this.settle();
    else this.refresh();
  }

  reportBotAction(acted) {
    const name = this.state.players[acted.seat]?.name ?? 'Bot';
    if (acted.kind === 'bid') {
      this.view.say(acted.seat, acted.value === 0 ? 'No call' : `${acted.value} point${acted.value > 1 ? 's' : ''}`);
      announce(`${name} ${acted.value === 0 ? 'passes the call' : `calls ${acted.value}`}`);
    } else if (acted.kind === 'pass') {
      this.view.say(acted.seat, 'Pass');
    } else if (acted.cards) {
      const combo = this.state.plays[this.state.plays.length - 1]?.combo;
      this.view.say(acted.seat, combo ? describeCombo(combo) : 'Plays');
    }
  }

  onBid(value) {
    if (this.state.phase !== Phase.BIDDING || this.state.bidding.turn !== 0) return;
    const res = bid(this.state, 0, value);
    if (!res.ok) {
      announce(res.error);
      return;
    }
    this.view.say(0, value === 0 ? 'No call' : `${value}`);
    this.refresh();
    this.drive();
  }

  onPlay(cards) {
    const res = play(this.state, 0, cards);
    if (!res.ok) {
      announce(res.error);
      this.view.nodes.comboLabel.textContent = res.error;
      return;
    }
    this.view.selected.clear();
    this.refresh();
    this.drive();
  }

  onPass() {
    const res = pass(this.state, 0);
    if (!res.ok) {
      announce(res.error);
      return;
    }
    this.refresh();
    this.drive();
  }

  settle() {
    if (this.settled) return;
    this.settled = true;
    const profile = this.app.profile;
    const result = this.state.result;
    const rescueMode = profile.rescueMode;
    const settlement = settleDouDiZhu({
      lobby: this.lobby,
      result,
      seat: 0,
      bankroll: profile.bankroll,
      rescueMode,
    });
    const before = gameStats(profile, this.gameId).rating;
    const { elo, bankrollChange } = recordResult(profile, {
      gameId: this.gameId,
      delta: settlement.delta,
      won: settlement.won,
      botElo: this.lobby.botElo,
      extra: {
        asLandlord: result.landlordSeat === 0,
        bombs: result.bombs,
        spring: result.spring || result.antiSpring,
      },
    });
    this.view.setBankroll(profile.bankroll);
    this.app.refreshChrome?.();

    const lines = [
      `Winner: <span>${result.landlordWon ? 'Landlord' : 'Farmers'}</span> · you played as <span>${result.landlordSeat === 0 ? 'landlord' : 'farmer'}</span>`,
      `Stake: <span>${formatChips(this.lobby.pot)}</span> × <span>${settlement.multiplier}</span>${result.landlordSeat === 0 ? ' × 2 (landlord)' : ''}`,
      `Points called <span>${result.bidValue}</span> · bombs <span>${result.bombs}</span>${result.spring ? ' · <span>spring</span>' : ''}${result.antiSpring ? ' · <span>anti-spring</span>' : ''}`,
      `Elo: <span>${before} → ${elo.rating}</span> (${elo.delta >= 0 ? '+' : ''}${elo.delta}, ${ratingTitle(elo.rating)})`,
      `Chips: <span>${formatChips(profile.bankroll)}</span>`,
    ];
    if (settlement.capped) {
      lines.splice(2, 0, `Loss capped at <span>${formatChips(Math.abs(settlement.delta))}</span> (gross ${formatChips(Math.abs(settlement.gross))})`);
    }
    if (bankrollChange.wentBankrupt) {
      lines.push('<span>Bankrupt.</span> You have been moved to the rescue table: 400 pot, no bankruptcy, until you hold 2,000.');
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
      lines,
      againLabel: canRepeat ? 'Deal again' : 'Choose another table',
      onAgain: () => (canRepeat ? this.newDeal() : this.app.go('lobby', { gameId: this.gameId })),
      onLeave: () => this.app.go('menu'),
    });
  }
}

export { SKILLS };
