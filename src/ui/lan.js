/**
 * Local network screens: choose, create, join, room lobby, and the table.
 *
 * Only reachable when the page is being served by the bundled host
 * (node server/server.js), because a page served over HTTPS is not allowed to
 * open a plain ws:// socket to a private address. The screen says so rather than
 * failing mysteriously.
 */

import { DEFAULT_ROOM_CURRENCY, ROOM_CURRENCIES, currencyLabel, formatMoney } from '../core/currency.js';
import { STARTING_STACK_MULTIPLE, stackForPot, suggestedStakes } from '../core/economy.js';
import { SKILLS } from '../games/doudizhu/ai.js';
import { LanClient } from '../net/client.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS, S2C } from '../net/protocol.js';
import { formatCode, parseCode, socketUrlFor } from '../net/roomcode.js';
import { TableView } from './tableview.js';
import { announce, button, clear, el, field, numberInput, select, wait } from './dom.js';

const NAME_KEY = 'card-games.lan-name';
// sessionStorage, not localStorage: the token is one seat in one room for this
// tab, and a second tab on the same device must not inherit it.
const RESUME_KEY = 'card-games.lan-resume';

const BACKOFF_MS = [500, 1_000, 2_000, 4_000];
const RECONNECT_BUDGET_MS = 45_000;
// A reload or a killed tab is usually a quick trip; if the host is gone there
// is no reason to keep the player on a spinner for most of a minute.
const COLD_START_BUDGET_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;
const RESUME_REPLY_MS = 6_000;
// Close code the host uses when a second socket resumes the same seat.
const REPLACED_CLOSE_CODE = 4000;

function storedName() {
  try {
    return globalThis.localStorage?.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name) {
  try {
    globalThis.localStorage?.setItem(NAME_KEY, name);
  } catch { /* private window: not worth mentioning */ }
}

function readResume() {
  try {
    const raw = globalThis.sessionStorage?.getItem(RESUME_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    const ok = record && typeof record.code === 'string' && typeof record.token === 'string' && typeof record.url === 'string';
    return ok ? record : null;
  } catch {
    return null;
  }
}

function saveResume(record) {
  try {
    globalThis.sessionStorage?.setItem(RESUME_KEY, JSON.stringify(record));
  } catch { /* storage blocked: the room works, it just cannot be rejoined */ }
}

function clearResume() {
  try {
    globalThis.sessionStorage?.removeItem(RESUME_KEY);
  } catch { /* nothing stored */ }
}

/** True when this page can open a ws:// socket to a private address. */
function lanReachable() {
  return location.protocol !== 'https:';
}

export function renderLan(app, root, params = {}) {
  const session = app.lanSession ?? (app.lanSession = { client: null, room: null, view: null });
  new LanScreens(app, root, session, params.gameId ?? 'doudizhu').start();
}

class LanScreens {
  constructor(app, root, session, gameId) {
    this.app = app;
    this.root = root;
    this.session = session;
    this.gameId = gameId;
    this.name = storedName();
    this.client = null;
    this.url = null;
    this.room = null;
    this.you = null;
    this.table = null;
    this.view = null;
    this.dealKey = null;
    this.lastResult = null;
    this.resultOverlay = null;
    this.onResize = null;
    this.left = false;
    this.unmounted = false;
    // Bumped to abandon a reconnect loop, so a late result from an old attempt
    // can tell it is no longer the current one.
    this.runId = 0;
    this.reconnecting = false;
    this.cold = false;
    this.wake = null;
    this.onWake = () => {
      if (this.unmounted || globalThis.document?.visibilityState === 'hidden') return;
      if (this.client?.connected || !readResume()) return;
      if (this.reconnecting) this.wake?.();
      else this.reconnect();
    };
  }

  start() {
    // main.js calls app.controller.unmount() on every route change.
    this.app.controller = { unmount: () => this.unmount() };
    globalThis.document?.addEventListener('visibilitychange', this.onWake);
    globalThis.addEventListener('online', this.onWake);
    // A reload or a killed tab leaves the record behind; use it.
    if (readResume() && lanReachable()) this.reconnect({ cold: true });
    else this.renderChoice();
  }

  /** Amounts in the room's currency; falls back to the default before a join. */
  money(value, compact = false) {
    return formatMoney(value, this.room?.settings?.currency ?? DEFAULT_ROOM_CURRENCY, compact);
  }

  shell(...children) {
    clear(this.root);
    this.root.append(
      el('header.topbar',
        el('div.topbar__brand', el('span.topbar__suits', '♠♥♣♦'), el('b', 'Local multiplayer')),
      ),
      el('main.page', ...children),
    );
  }

  backLink(label, onclick) {
    return el('button.back-link', { type: 'button', onclick }, `← ${label}`);
  }

  notReachable() {
    return el('div.notice.notice--warn',
      el('b', 'This page cannot reach a host on your network. '),
      'It was served over HTTPS, and browsers refuse a plain connection from an HTTPS page to a private address. ',
      'Run ', el('code', 'node server/server.js'), ' on one machine and open the address it prints — everything on the network loads from there, and local multiplayer works.',
    );
  }

  renderChoice() {
    this.shell(
      this.backLink('All games', () => this.app.go('mode', { gameId: this.gameId })),
      el('div.page__head',
        el('h1.page__title', 'Play on this network'),
        el('p.page__sub', 'One device hosts the table and everyone else joins with a five-character code. No accounts, no internet — the cards never leave your network.'),
      ),
      lanReachable() ? null : this.notReachable(),
      el('div.tiles',
        el('button.tile', { type: 'button', style: '--accent:#cdae6c', onclick: () => this.renderCreate() },
          el('span.tile__accent'),
          el('h2.tile__name', 'Create a room'),
          el('p.tile__tag', 'You are the host'),
          el('p.tile__desc', 'Choose the coins, the pot, the starting stack, the multiplier and how many seats the bots fill, then hand out the code.'),
        ),
        el('button.tile', { type: 'button', style: '--accent:#2f6fc8', onclick: () => this.renderJoin() },
          el('span.tile__accent'),
          el('h2.tile__name', 'Join a room'),
          el('p.tile__tag', 'You have a code'),
          el('p.tile__desc', 'Type the five characters the host read out. Add @address if you opened this page from somewhere else.'),
        ),
      ),
      el('div.rule'),
      el('div.card-panel',
        el('h2', { style: 'font-family:var(--font);margin:0 0 10px;font-size:19px' }, 'Hosting, in three steps'),
        el('ol', { style: 'margin:0;padding-left:20px;line-height:1.8;color:#cfc9ba;font-size:14px' },
          el('li', 'On the host machine: ', el('code', 'node server/server.js')),
          el('li', 'Everyone opens the http://… address it prints, on the same Wi-Fi'),
          el('li', 'Host creates a room, reads out the code, the rest join'),
        ),
      ),
    );
  }

  renderJoin() {
    const codeInput = el('input.input', {
      id: 'join-code', placeholder: 'ABCDE', maxlength: 32, autocapitalize: 'characters', spellcheck: 'false',
      style: 'font-family:var(--font);font-size:24px;letter-spacing:0.18em;text-align:center',
    });
    const nameInput = el('input.input', { id: 'join-name', value: this.name, maxlength: 18, placeholder: 'Your name' });
    const status = el('p.footnote', '');
    const go = async () => {
      const parsed = parseCode(codeInput.value);
      if (!parsed.valid) {
        status.textContent = 'That does not look like a room code. Five characters, e.g. KRM7Q.';
        return;
      }
      this.name = nameInput.value.trim() || 'Player';
      rememberName(this.name);
      status.textContent = 'Connecting…';
      this.dropTable();
      this.room = null;
      try {
        await this.connect(socketUrlFor(parsed, location));
        this.client.joinRoom(parsed.code, this.name);
      } catch (error) {
        status.textContent = error.message;
      }
    };

    this.shell(
      this.backLink('Local multiplayer', () => this.renderChoice()),
      el('div.page__head', el('h1.page__title', 'Join a room')),
      lanReachable() ? null : this.notReachable(),
      el('div.card-panel',
        el('div.form-grid',
          field('Room code', codeInput, 'The five characters the host read out'),
          field('Your name', nameInput, 'Shown at the table'),
        ),
        el('div.btn-row', { style: 'margin-top:18px' },
          el('button.btn.btn--primary.btn--big', { type: 'button', onclick: go }, 'Join'),
        ),
        status,
      ),
    );
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go();
    });
    codeInput.focus();
  }

  renderCreate() {
    const s = { ...DEFAULT_SETTINGS };
    const nameInput = el('input.input', { value: this.name, maxlength: 18, placeholder: 'Your name' });
    const currency = select('set-currency',
      ROOM_CURRENCIES.map((c) => ({ value: c.code, label: c.name })), s.currency);
    const pot = numberInput('set-pot', s.pot, SETTING_LIMITS.pot);
    const chips = numberInput('set-chips', s.startingChips, SETTING_LIMITS.startingChips);
    const preview = el('span.field__hint', '');
    // The stack follows the pot at the house multiple until the host types a
    // stack of their own; after that it is theirs and nothing overwrites it.
    let potEdited = false;
    let stackEdited = false;
    const syncStack = () => {
      if (!stackEdited) chips.value = String(stackForPot(Number(pot.value) || 0));
    };
    const refreshPreview = () => {
      const code = currency.value;
      const potValue = Number(pot.value) || 0;
      preview.textContent = `Pot ${formatMoney(potValue, code)} · stack ${formatMoney(Number(chips.value) || 0, code)}`
        + ` · a landlord win at ×2 settles ${formatMoney(potValue * 2 * 2, code)}`;
    };
    currency.addEventListener('change', () => {
      if (!potEdited) pot.value = String(suggestedStakes(currency.value).pot);
      syncStack();
      refreshPreview();
    });
    pot.addEventListener('input', () => {
      potEdited = true;
      syncStack();
      refreshPreview();
    });
    chips.addEventListener('input', () => {
      stackEdited = true;
      refreshPreview();
    });
    const mult = numberInput('set-mult', s.baseMultiplier, SETTING_LIMITS.baseMultiplier);
    const cap = numberInput('set-cap', s.capFactor, SETTING_LIMITS.capFactor);
    const seats = select('set-seats', [
      { value: '1', label: '1 human, 2 bots' },
      { value: '2', label: '2 humans, 1 bot' },
      { value: '3', label: '3 humans' },
    ], String(s.humanSeats));
    const skill = select('set-skill', Object.entries(SKILLS).map(([id, def]) => ({ value: id, label: def.name })), s.botSkill);
    const status = el('p.footnote', '');
    refreshPreview();

    const go = async () => {
      this.name = nameInput.value.trim() || 'Host';
      rememberName(this.name);
      status.textContent = 'Starting the room…';
      this.dropTable();
      this.room = null;
      try {
        await this.connect(socketUrlFor({ host: null }, location));
        this.client.createRoom(this.name, {
          currency: currency.value,
          pot: Number(pot.value),
          startingChips: Number(chips.value),
          baseMultiplier: Number(mult.value),
          capFactor: Number(cap.value),
          humanSeats: Number(seats.value),
          botSkill: skill.value,
        });
      } catch (error) {
        status.textContent = error.message;
      }
    };

    this.shell(
      this.backLink('Local multiplayer', () => this.renderChoice()),
      el('div.page__head',
        el('h1.page__title', 'Create a room'),
        el('p.page__sub', 'Your settings apply to everyone at the table. The coins are dealt out when the room opens and are gone when it closes — they are not money, and they never touch your single-player purse.'),
      ),
      lanReachable() ? null : this.notReachable(),
      el('div.card-panel',
        el('div.form-grid',
          field('Your name', nameInput),
          field('Seats', seats, 'Bots fill whatever is left of the three'),
          field('Coins', currency, 'Silver for a quick game, gold for a heavy one'),
          field('Pot per person', pot, 'What each seat puts up'),
          field('Starting stack', chips, `Everyone begins with this — ${STARTING_STACK_MULTIPLE} pots unless you say otherwise`),
          field('Base multiplier', mult, 'The starting factor; the points called, then each bomb, rocket and spring, multiply it further'),
          field('Hand ceiling (× pot)', cap, 'The most one hand can move, won or lost'),
          field('Bot strength', skill, 'For any seat a person does not take'),
        ),
        el('p.field__hint', { style: 'margin:14px 0 0' }, preview),
        el('div.btn-row', { style: 'margin-top:18px' },
          el('button.btn.btn--primary.btn--big', { type: 'button', onclick: go }, 'Open the room'),
        ),
        status,
      ),
    );
  }

  async connect(url, timeoutMs) {
    if (!lanReachable()) throw new Error('This page was served over HTTPS and cannot reach a host on your network.');
    // close() clears the old client's handlers, so its late 'close' cannot
    // start a reconnect behind the new socket's back.
    this.client?.close();
    const client = new LanClient();
    this.client = client;
    this.url = url;
    this.session.client = client;
    client.on(S2C.ERROR, (message) => {
      if (message.code === 'resume_failed') this.onResumeFailed();
      else this.toast(message.message);
    });
    client.on(S2C.ROOM, (message) => this.onRoom(message));
    client.on(S2C.VIEW, (message) => this.onView(message));
    client.on(S2C.EVENT, (message) => this.onEvent(message));
    client.on(S2C.RESULT, (message) => this.onResult(message));
    client.on('close', (info) => this.onDisconnect(client, info));
    await client.connect(url, timeoutMs);
    return client;
  }

  /** The small caption in the table's controls row; false when there is no table. */
  setCaption(text) {
    const node = this.table?.nodes?.comboLabel;
    if (!node) return false;
    node.textContent = text;
    if (text) announce(text);
    return true;
  }

  toast(text) {
    // The table screen has no .footnote, so a refused play was silent.
    if (this.table) {
      this.setCaption(text);
      return;
    }
    const node = this.root.querySelector('.footnote');
    if (node) node.textContent = text;
  }

  onRoom(message) {
    const previousHost = this.room?.hostId;
    this.room = message.room;
    this.you = message.you;
    this.session.room = message.room;
    if (message.token) saveResume({ code: message.room.code, token: message.token, url: this.url });
    this.endReconnect();
    const room = this.room;
    // Someone can join between hands, so 'finished' or 'playing' may arrive
    // before this device has ever been dealt a view.
    if (room.phase === 'lobby' || (!this.view && (room.phase === 'finished' || room.phase === 'playing'))) {
      this.dropTable();
      this.renderRoomLobby();
    } else if (!this.table) this.renderTable();
    else this.updateTableMeta();
    // The old host left: the card still says "Waiting for the host", so rebuild
    // it now that the button is ours.
    if (previousHost !== room.hostId && room.hostId === this.you && this.lastResult && this.resultOverlay?.isConnected) {
      this.resultOverlay.remove();
      this.onResult(this.lastResult);
    }
  }

  clearResult() {
    this.resultOverlay?.remove();
    this.resultOverlay = null;
    this.lastResult = null;
    for (const node of this.root.querySelectorAll(':scope > .overlay')) node.remove();
  }

  onView(message) {
    // view.deal restarts at 0 every hand; the room's hand counter is what tells
    // one hand from the next.
    const key = `${message.hand ?? ''}:${message.view.deal}`;
    const firstOfDeal = key !== this.dealKey;
    this.dealKey = key;
    if (firstOfDeal) this.clearResult();
    this.view = message.view;
    if (!this.table) this.renderTable();
    this.table.update(message.view);
    // The host drives the hand, so the flourish runs alongside rather than
    // holding anything up. Only at the bidding stage: rejoining mid-play should
    // not replay a deal over a hand that is half played.
    if (firstOfDeal && message.view.phase === 'bidding') this.table.dealIn();
  }

  onEvent(message) {
    if (message.kind === 'say') this.table?.say(message.seat, message.text);
    if (message.kind === 'left') this.table?.say(message.seat, `${message.name} left`);
    if (message.kind === 'back') this.table?.say(message.seat, `${message.name} is back`);
  }

  onResult(message) {
    this.lastResult = message;
    const mine = message.rows.find((row) => row.seat === this.view?.seat);
    if (!mine || !this.table) return;
    // A resume replays the last result; never stack two cards.
    this.resultOverlay?.remove();
    const lines = message.rows.map((row) =>
      `${row.seat === this.view.seat ? 'You' : row.name}: <span>${row.delta >= 0 ? '+' : '−'}${this.money(Math.abs(row.delta))}</span> → ${this.money(row.chips)}${row.capped ? ' (capped)' : ''}`);
    lines.unshift(`Winner: <span>${message.result.landlordWon ? 'Landlord' : 'Farmers'}</span> at <span>×${message.multiplier}</span>`);
    const isHost = this.room?.hostId === this.you;
    this.resultOverlay = this.table.showResult({
      title: mine.won ? 'You win' : 'You lose',
      win: mine.won,
      deltaText: `${mine.delta >= 0 ? '+' : '−'}${this.money(Math.abs(mine.delta))}`,
      lines,
      againLabel: isHost ? 'Deal again' : 'Waiting for the host',
      onAgain: () => (isHost ? this.client.again() : null),
      onLeave: () => this.leave(),
    });
  }

  onDisconnect(client, info) {
    if (client !== this.client || this.left || this.unmounted) return;
    // The loop is already driving; a failed attempt closes its own socket.
    if (this.reconnecting) return;
    // Another tab resumed this token and the server closed us with 4000. Rejoining
    // would close that tab in turn, and the two would trade the seat forever.
    if (info?.code === REPLACED_CLOSE_CODE) {
      this.renderReplaced();
      return;
    }
    if (readResume()) {
      this.reconnect();
      return;
    }
    // Never got into a room: the join/create form already reports the failure.
    if (!this.room) return;
    this.renderGaveUp();
  }

  /**
   * Walk back into the seat the server is holding. One loop at a time: every
   * await below re-checks runId, so an abandoned attempt cannot touch the
   * screen or the client once a newer one (or a success) has taken over.
   */
  reconnect({ cold = false } = {}) {
    const record = readResume();
    if (!record || this.unmounted) return;
    if (this.reconnecting) {
      this.wake?.();
      return;
    }
    const run = ++this.runId;
    this.reconnecting = true;
    this.cold = cold;
    this.showReconnecting(record.code, cold);
    this.reconnectLoop(run, record, cold ? COLD_START_BUDGET_MS : RECONNECT_BUDGET_MS);
  }

  isCurrent(run) {
    return run === this.runId && !this.unmounted;
  }

  showReconnecting(code, cold) {
    const text = cold ? `Rejoining room ${code}…` : `Reconnecting to room ${code}…`;
    if (this.setCaption(text)) return;
    this.shell(
      el('div.page__head',
        el('h1.page__title', text),
        el('p.page__sub', 'Finding your seat again.'),
      ),
      el('div.btn-row', button('Leave room', () => this.leave())),
    );
    announce(text);
  }

  async reconnectLoop(run, record, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (let attempt = 0; ; attempt += 1) {
      if (!this.isCurrent(run)) return;
      let outcome;
      try {
        const client = await this.connect(record.url, CONNECT_TIMEOUT_MS);
        if (!this.isCurrent(run)) {
          if (this.unmounted) client.close();
          return;
        }
        client.resume(record.code, record.token);
        outcome = await this.awaitResume(client);
      } catch {
        outcome = 'unreachable';
      }
      // A ROOM frame (success) or resume_failed has already bumped runId.
      if (!this.isCurrent(run)) return;
      if (outcome === 'replaced') {
        this.renderReplaced();
        return;
      }
      this.client?.close();
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      if (Date.now() + delay >= deadline) {
        this.giveUp();
        return;
      }
      await this.sleep(delay);
    }
  }

  /** Settles on the first ROOM, resume_failed, close or timeout from this client. */
  awaitResume(client) {
    return new Promise((resolve) => {
      const offs = [];
      let timer;
      const done = (outcome) => {
        clearTimeout(timer);
        offs.forEach((off) => off());
        resolve(outcome);
      };
      timer = setTimeout(() => done('timeout'), RESUME_REPLY_MS);
      offs.push(
        client.on(S2C.ROOM, () => done('ok')),
        client.on(S2C.ERROR, (message) => { if (message.code === 'resume_failed') done('failed'); }),
        client.on('close', (info) => done(info?.code === REPLACED_CLOSE_CODE ? 'replaced' : 'closed')),
      );
    });
  }

  /** Backoff pause that visibilitychange / online can cut short. */
  sleep(ms) {
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** A ROOM frame arrived: whatever loop was running has won. */
  endReconnect() {
    if (!this.reconnecting) return;
    this.runId += 1;
    this.reconnecting = false;
    this.cold = false;
    this.wake?.();
    if (this.table) this.setCaption('');
  }

  onResumeFailed() {
    const cold = this.cold;
    this.runId += 1;
    this.reconnecting = false;
    this.cold = false;
    this.wake?.();
    clearResume();
    this.client?.close();
    this.dropTable();
    if (cold) this.renderChoice();
    else this.renderClosed();
  }

  giveUp() {
    const cold = this.cold;
    this.runId += 1;
    this.reconnecting = false;
    this.cold = false;
    this.client?.close();
    if (cold) {
      clearResume();
      this.renderChoice();
    } else {
      this.renderGaveUp();
    }
  }

  /** Walking away from a dead room: nothing should try to rejoin it later. */
  abandon() {
    clearResume();
    this.client?.close();
    this.renderChoice();
  }

  renderGaveUp() {
    this.dropTable();
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'Can\'t reach the host'),
        el('p.page__sub', 'The connection to the room dropped and could not be restored.'),
      ),
      el('div.btn-row',
        readResume() ? button('Try again', () => this.reconnect(), { class: 'btn--primary' }) : null,
        button('Back to local multiplayer', () => this.abandon()),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  /**
   * The seat now belongs to another tab. Stop any loop, forget the token in
   * this tab (so a reload here does not fight for it again) and dead-end.
   */
  renderReplaced() {
    this.runId += 1;
    this.reconnecting = false;
    this.cold = false;
    this.wake?.();
    clearResume();
    this.client?.close();
    this.dropTable();
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'Opened in another tab'),
        el('p.page__sub', 'This seat is now being played from another tab or window.'),
      ),
      el('div.btn-row',
        button('Back to local multiplayer', () => this.renderChoice(), { class: 'btn--primary' }),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  renderClosed() {
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'That room has closed'),
        el('p.page__sub', 'The host closed the room, or your seat was given up while you were away.'),
      ),
      el('div.btn-row',
        button('Back to local multiplayer', () => this.renderChoice(), { class: 'btn--primary' }),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  dropTable() {
    this.table?.destroy();
    this.table = null;
    if (this.onResize) globalThis.removeEventListener('resize', this.onResize);
    this.onResize = null;
    this.view = null;
    this.dealKey = null;
    this.lastResult = null;
    this.resultOverlay = null;
  }

  leave() {
    this.unmount();
    this.app.go('menu');
  }

  /**
   * Registered as app.controller. leave() reaches it directly and again through
   * app.go() -> teardown(), so it must be safe to run twice.
   */
  unmount() {
    if (this.unmounted) return;
    this.unmounted = true;
    this.left = true;
    this.runId += 1;
    this.reconnecting = false;
    this.wake?.();
    globalThis.document?.removeEventListener('visibilitychange', this.onWake);
    globalThis.removeEventListener('online', this.onWake);
    // Best effort: a seat left without a LEAVE frame is held for up to ten
    // minutes, then freed by the host's sweep.
    if (this.client?.connected) this.client.leave();
    this.client?.close();
    clearResume();
    this.dropTable();
  }

  renderRoomLobby() {
    const room = this.room;
    const isHost = room.hostId === this.you;
    const hostInfo = this.client?.hostInfo;
    // The big line is the five characters people read out. The address belongs
    // underneath, for anyone whose page came from somewhere else.
    const fullCode = hostInfo?.host ? formatCode(room.code, hostInfo.host, hostInfo.port) : room.code;
    const seated = room.seats.filter((s) => s.id).length;
    const ready = seated >= 1;

    const seatList = el('ul.seat-list');
    room.seats.forEach((seat) => {
      const bot = !seat.id;
      seatList.append(el('li', { class: seat.isHost ? 'is-host' : '' },
        el('span', `Seat ${seat.seat + 1}`),
        el('span', { style: 'flex:1' }, bot
          ? `Bot (${SKILLS[room.settings.botSkill]?.name ?? room.settings.botSkill})`
          : (seat.connected === false ? `${seat.name} (away)` : seat.name)),
        seat.isHost ? el('span', 'host') : null,
        el('span', { style: 'color:var(--gold)' }, seat.id ? this.money(seat.chips, true) : '—'),
      ));
    });

    this.shell(
      this.backLink('Leave room', () => this.leave()),
      el('div.page__head',
        el('h1.page__title', isHost ? 'Your room is open' : 'Waiting for the host'),
        el('p.page__sub', isHost
          ? 'Read the code out. Everyone else opens this same address and joins.'
          : 'You are seated. The host starts the hand.'),
      ),
      el('div.card-panel',
        el('div.room-code', room.code),
        el('p.room-url', hostInfo?.host
          ? `Everyone opens http://${hostInfo.host}:${hostInfo.port} on this network, then joins with ${room.code}. From another page, the full code is ${fullCode}.`
          : `Others join with ${room.code}`),
        seatList,
        el('div.stat-grid', { style: 'margin-top:18px' },
          statTile(`Pot per person`, this.money(room.settings.pot)),
          statTile('Starting stack', this.money(room.settings.startingChips)),
          statTile('Coins', currencyLabel(room.settings.currency)),
          statTile('Base multiplier', `×${room.settings.baseMultiplier}`),
          statTile('Hand ceiling', `${room.settings.capFactor}× pot`),
        ),
        el('div.btn-row', { style: 'margin-top:20px' },
          isHost
            ? el('button.btn.btn--primary.btn--big', { type: 'button', disabled: !ready, onclick: () => this.client.start() }, 'Deal')
            : el('span.footnote', 'The host will deal when everyone is in.'),
        ),
      ),
    );
  }

  renderTable() {
    // A second table (or a second resize listener) would keep painting after
    // the first one left the screen.
    if (this.onResize) globalThis.removeEventListener('resize', this.onResize);
    this.table?.destroy();
    clear(this.root);
    const settings = this.room?.settings ?? DEFAULT_SETTINGS;
    const mine = this.room?.seats.find((s) => s.id === this.you);
    this.table = new TableView({
      root: this.root,
      meta: {
        lobbyName: `Room ${this.room?.code ?? ''}`,
        potLabel: formatMoney(settings.pot, settings.currency, true),
        bankroll: mine?.chips ?? settings.startingChips,
        baseMultiplier: settings.baseMultiplier,
        currency: settings.currency,
      },
      handlers: {
        // Mid-reconnect the new socket has not resumed yet, so a move would reach
        // the server as "not in a room" and overwrite the caption. Drop it.
        onBid: (value) => { if (!this.guardReconnecting()) this.client.bid(value); },
        onPlay: (cards) => { if (!this.guardReconnecting()) this.client.play(cards); },
        onPass: () => { if (!this.guardReconnecting()) this.client.pass(); },
        onLeave: () => this.leave(),
      },
    });
    if (this.view) this.table.update(this.view);
    this.onResize = () => this.table?.renderHand();
    globalThis.addEventListener('resize', this.onResize);
  }

  /** True (and the caption refreshed) while a reconnect is in flight. */
  guardReconnecting() {
    if (!this.reconnecting) return false;
    const code = readResume()?.code ?? this.room?.code;
    if (code) this.setCaption(this.cold ? `Rejoining room ${code}…` : `Reconnecting to room ${code}…`);
    return true;
  }

  updateTableMeta() {
    const mine = this.room?.seats.find((s) => s.id === this.you);
    if (mine && this.table) this.table.setBankroll(mine.chips);
  }
}

function statTile(k, v) {
  return el('div.stat', el('div.stat__k', k), el('div.stat__v', v));
}

export { wait };
