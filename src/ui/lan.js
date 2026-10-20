/**
 * Multiplayer screens: choose, create, join, room lobby, and the table.
 *
 * Two modes share every screen. 'online' talks to the public host (or, on an
 * http page, to the server that served the page) and hands out invite links.
 * 'lan' is the original local-network play: it needs the page itself to be
 * served over http by the bundled host (node server/server.js), because an
 * HTTPS page is not allowed to open a plain ws:// socket to a private address.
 * The lan screens say so rather than failing mysteriously.
 */

import { DEFAULT_ROOM_CURRENCY, formatMoney } from '../core/currency.js';
import { STARTING_STACK_MULTIPLE } from '../core/economy.js';
import { SKILLS as BIG2_SKILLS } from '../games/big2/ai.js';
import { classify } from '../games/big2/rules.js';
import { SKILLS as DDZ_SKILLS } from '../games/doudizhu/ai.js';
import { LanClient } from '../net/client.js';
import { healthUrlFor, onlineSocketUrl } from '../net/config.js';
import { SETTING_LIMITS, SEATS_BY_GAME, S2C, defaultSettings } from '../net/protocol.js';
import { formatCode, normaliseCode, parseCode, socketUrlFor } from '../net/roomcode.js';
import { Big2View } from './big2.js';
import { TableView } from './tableview.js';
import { wordmark } from './screens.js';
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
// The public host sleeps when idle and takes about a minute to wake.
const ONLINE_RECONNECT_TIMEOUT_MS = 20_000;
const ONLINE_FIRST_CONNECT_MS = 75_000;
const WAKE_NOTICE_AFTER_MS = 1_500;
const WAKE_NOTICE = 'Waking the game server — the first game after a quiet spell can take up to a minute.';
const FIRST_CONNECT_RETRY_MS = 2_000;
// Render sleeps a free service after about 15 minutes without traffic.
const KEEP_ALIVE_MS = 4 * 60_000;
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

/** Player names reach the result card through innerHTML, so they are escaped first. */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** One result row with every field forced to its expected type, whatever the wire sent. */
function cleanRow(row) {
  return {
    seat: row.seat,
    name: String(row.name ?? ''),
    isBot: Boolean(row.isBot),
    cardsLeft: Number(row.cardsLeft),
    delta: Number(row.delta),
    chips: Number(row.chips),
    capped: Boolean(row.capped),
    won: Boolean(row.won),
  };
}

function skillsFor(game) {
  return game === 'big2' ? BIG2_SKILLS : DDZ_SKILLS;
}

export function renderLan(app, root, params = {}) {
  const session = app.lanSession ?? (app.lanSession = { client: null, room: null, view: null });
  new LanScreens(app, root, session, params).start();
}

class LanScreens {
  constructor(app, root, session, params) {
    this.app = app;
    this.root = root;
    this.session = session;
    // Only a hint until a room exists; room.settings.game decides after that.
    this.gameId = params.gameId === 'big2' ? 'big2' : 'doudizhu';
    this.mode = params.mode ?? (location.protocol === 'http:' ? 'lan' : 'online');
    this.online = this.mode === 'online';
    this.joinCode = params.joinCode ?? null;
    this.areaName = this.online ? 'online play' : 'local multiplayer';
    this.name = storedName();
    this.client = null;
    this.url = null;
    this.room = null;
    this.you = null;
    this.table = null;
    this.tableGame = null;
    this.view = null;
    this.dealKey = null;
    // Set on every new socket so the first VIEW after (re)connecting redraws the
    // standing play, which the trick display cannot recover from the VIEW alone.
    this.needSync = false;
    this.lastResult = null;
    this.resultOverlay = null;
    this.onResize = null;
    this.keepAlive = null;
    this.left = false;
    this.unmounted = false;
    // Bumped to abandon a reconnect loop, so a late result from an old attempt
    // can tell it is no longer the current one.
    this.runId = 0;
    // Bumped by every form screen and every submit, so a connect loop left over
    // from Back or a double tap can tell it is no longer the live attempt.
    this.formRun = 0;
    // Set by a submit while it is in flight; puts its button back on a failure.
    this.reenable = null;
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

  /** The table's game: the room's once there is one, else the screen it was opened from. */
  get game() {
    const game = this.room?.settings?.game ?? this.gameId;
    return game === 'big2' ? 'big2' : 'doudizhu';
  }

  reachable() {
    return this.online || lanReachable();
  }

  socketUrl(parsed) {
    return this.online ? onlineSocketUrl(location) : socketUrlFor(parsed, location);
  }

  start() {
    // main.js calls app.controller.unmount() on every route change.
    this.app.controller = { unmount: () => this.unmount() };
    globalThis.document?.addEventListener('visibilitychange', this.onWake);
    globalThis.addEventListener('online', this.onWake);
    const record = readResume();
    // An invite link for a different room beats a stale seat from an earlier one.
    if (record && this.joinCode && record.code !== normaliseCode(this.joinCode)) clearResume();
    // A reload or a killed tab leaves the record behind; use it.
    if (readResume() && this.reachable()) this.reconnect({ cold: true });
    else if (this.joinCode) this.renderJoin({ code: normaliseCode(this.joinCode), fromInvite: true });
    else this.renderChoice();
  }

  /** Amounts in the room's currency; falls back to the default before a join. */
  money(value, compact = false) {
    return formatMoney(Number(value), this.room?.settings?.currency ?? DEFAULT_ROOM_CURRENCY, compact);
  }

  shell(...children) {
    clear(this.root);
    this.root.append(
      el('header.topbar',
        wordmark(),
      ),
      el('main.page', ...children),
    );
  }

  backLink(label, onclick) {
    return el('button.back-link', { type: 'button', onclick }, `← ${label}`);
  }

  /** Label for the back link that returns to this mode's choice screen. */
  get modeName() {
    return this.online ? 'Play online' : 'Local network';
  }

  notReachable() {
    return el('div.notice.notice--warn',
      el('b', 'This page cannot reach a host on your network. '),
      'It was served over HTTPS, and browsers refuse a plain connection from an HTTPS page to a private address. ',
      'Run ', el('code', 'node server/server.js'), ' on one machine and open the address it prints — everything on the network loads from there, and local multiplayer works.',
    );
  }

  renderChoice() {
    this.formRun += 1;
    this.reenable = null;
    this.stopKeepAlive();
    this.shell(
      this.backLink('All games', () => this.app.go('mode', { gameId: this.gameId })),
      el('div.page__head',
        el('h1.page__title', this.online ? 'Play online' : 'Play on this network'),
        el('p.page__sub', this.online
          ? 'Make a room, send the link, and friends join from anywhere.'
          : 'One device hosts the table and everyone else joins with a five-character code. No accounts, no internet — the cards never leave your network.'),
      ),
      this.reachable() ? null : this.notReachable(),
      el('div.tiles',
        el('button.tile', { type: 'button', onclick: () => this.renderCreate() },
          el('h2.tile__name', 'Create a room'),
          el('p.tile__tag', 'You are the host'),
          el('p.tile__desc', this.online
            ? 'Pick the seats and the starting coins, then share the invite link.'
            : 'Pick the seats and the starting coins, then read out the code.'),
        ),
        el('button.tile', { type: 'button', onclick: () => this.renderJoin() },
          el('h2.tile__name', 'Join a room'),
          el('p.tile__tag', 'You have a code'),
          el('p.tile__desc', this.online
            ? 'Type the five characters the host sent, or open the invite link.'
            : 'Type the five characters the host read out. Add @address if you opened this page from somewhere else.'),
        ),
      ),
      this.online ? null : el('div.rule'),
      this.online ? null : el('div.card-panel',
        el('h2.panel__title', 'Hosting, in three steps'),
        el('ol.panel__list',
          el('li', 'On the host machine: ', el('code', 'node server/server.js')),
          el('li', 'Everyone opens the http://… address it prints, on the same Wi-Fi'),
          el('li', 'Host creates a room, reads out the code, the rest join'),
        ),
      ),
    );
  }

  renderJoin({ code = '', fromInvite = false } = {}) {
    this.formRun += 1;
    this.reenable = null;
    const codeInput = el('input.input.input--code', {
      id: 'join-code', placeholder: 'ABCDE', maxlength: 32, autocapitalize: 'characters', spellcheck: 'false', value: code,
    });
    const nameInput = el('input.input', { id: 'join-name', value: this.name, maxlength: 18, placeholder: 'Your name' });
    const status = el('p.footnote', '');
    const submit = el('button.btn.btn--primary.btn--big', { type: 'button', onclick: () => go() }, 'Join');
    const go = async () => {
      if (submit.disabled) return;
      const parsed = parseCode(codeInput.value);
      if (!parsed.valid) {
        status.textContent = 'That does not look like a room code. Five characters, e.g. KRM7Q.';
        return;
      }
      const attempt = ++this.formRun;
      submit.disabled = true;
      this.reenable = () => { submit.disabled = false; };
      this.name = nameInput.value.trim() || 'Player';
      rememberName(this.name);
      status.textContent = 'Connecting…';
      this.dropTable();
      this.room = null;
      try {
        const client = await this.connectFresh(this.socketUrl(parsed), status, attempt);
        if (!client) return;
        if (attempt !== this.formRun) {
          this.abandonAttempt(client);
          return;
        }
        status.textContent = 'Joining the room…';
        client.joinRoom(parsed.code, this.name);
      } catch (error) {
        if (attempt !== this.formRun) return;
        status.textContent = String(error?.message ?? error);
        submit.disabled = false;
      }
    };

    this.shell(
      this.backLink(this.modeName, () => this.renderChoice()),
      el('div.page__head', el('h1.page__title', 'Join a room')),
      this.reachable() ? null : this.notReachable(),
      el('div.card-panel',
        el('div.form-grid',
          field('Room code', codeInput, this.online ? 'The five characters the host sent' : 'The five characters the host read out'),
          field('Your name', nameInput, 'Shown at the table'),
        ),
        el('div.btn-row.btn-row--spaced',
          submit,
        ),
        status,
      ),
    );
    codeInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') go();
    });
    if (fromInvite && code) {
      // A remembered name means nothing is left to ask.
      if (this.name) go();
      else nameInput.focus();
    } else codeInput.focus();
  }

  renderCreate() {
    this.formRun += 1;
    this.reenable = null;
    const game = this.gameId;
    const isBig2 = game === 'big2';
    const seatCount = SEATS_BY_GAME[game];
    const s = { ...defaultSettings(game) };
    const nameInput = el('input.input', { value: this.name, maxlength: 18, placeholder: 'Your name' });
    // Big Two pays a tenth of the pot per card, so a smaller stack would round
    // the rate down to nothing.
    const limits = { ...SETTING_LIMITS.startingChips, min: isBig2 ? 100 : SETTING_LIMITS.startingChips.min };
    const chips = numberInput('set-chips', s.startingChips, limits);
    const preview = el('span.field__hint', '');
    // The pot is not a second thing to get wrong: it is the stack divided by the
    // house multiple, so typing one number sets both.
    const startingChips = () => Math.min(limits.max, Math.max(limits.min, Math.round(Number(chips.value) || 0)));
    // Big Two's rate is the pot over ten and must stay a whole number of coins.
    const potFor = (stack) => (isBig2
      ? Math.max(10, Math.round(stack / (STARTING_STACK_MULTIPLE * 10)) * 10)
      : Math.max(1, Math.round(stack / STARTING_STACK_MULTIPLE)));
    const refreshPreview = () => {
      const stack = startingChips();
      const pot = potFor(stack);
      const head = `Everyone starts with ${formatMoney(stack, DEFAULT_ROOM_CURRENCY)}`;
      preview.textContent = isBig2
        ? `${head} · each card left in a loser's hand pays ${formatMoney(pot / 10, DEFAULT_ROOM_CURRENCY)}`
        : `${head} · a landlord win at ×2 moves ${formatMoney(pot * 4, DEFAULT_ROOM_CURRENCY)}`;
    };
    chips.addEventListener('input', refreshPreview);
    const seatOptions = [];
    for (let humans = 1; humans <= seatCount; humans += 1) {
      const bots = seatCount - humans;
      seatOptions.push({
        value: String(humans),
        label: bots === 0 ? `${humans} humans` : `${humans} human${humans > 1 ? 's' : ''}, ${bots} bot${bots > 1 ? 's' : ''}`,
      });
    }
    const seats = select('set-seats', seatOptions, String(Math.min(s.humanSeats, seatCount)));
    const skill = select('set-skill', Object.entries(skillsFor(game)).map(([id, def]) => ({ value: id, label: def.name })), s.botSkill);
    const skillField = field('Bot strength', skill, 'For any seat a person does not take');
    // Only worth asking while a bot will actually sit down.
    const needsBots = () => Number(seats.value) < seatCount;
    const syncSkill = () => { skillField.hidden = !needsBots(); };
    seats.addEventListener('change', syncSkill);
    syncSkill();
    const status = el('p.footnote', '');
    refreshPreview();

    const submit = el('button.btn.btn--primary.btn--big', { type: 'button', onclick: () => go() }, 'Open the room');
    const go = async () => {
      if (submit.disabled) return;
      const attempt = ++this.formRun;
      submit.disabled = true;
      this.reenable = () => { submit.disabled = false; };
      this.name = nameInput.value.trim() || 'Host';
      rememberName(this.name);
      status.textContent = 'Starting the room…';
      this.dropTable();
      this.room = null;
      try {
        const client = await this.connectFresh(this.socketUrl({ host: null }), status, attempt);
        if (!client) return;
        if (attempt !== this.formRun) {
          this.abandonAttempt(client);
          return;
        }
        status.textContent = 'Opening the room…';
        const stack = startingChips();
        client.createRoom(this.name, {
          game,
          currency: DEFAULT_ROOM_CURRENCY,
          pot: potFor(stack),
          startingChips: stack,
          humanSeats: Number(seats.value),
          // A hidden select still holds a value; don't send a choice nobody saw.
          botSkill: needsBots() ? skill.value : defaultSettings(game).botSkill,
        });
      } catch (error) {
        if (attempt !== this.formRun) return;
        status.textContent = String(error?.message ?? error);
        submit.disabled = false;
      }
    };

    this.shell(
      this.backLink(this.modeName, () => this.renderChoice()),
      el('div.page__head',
        el('h1.page__title', 'Create a room'),
        el('p.page__sub', 'Set the seats and how many coins everyone starts with, then send the invite link.'),
      ),
      this.reachable() ? null : this.notReachable(),
      el('div.card-panel',
        el('div.form-grid',
          field('Your name', nameInput),
          field('Seats', seats, `Bots fill whatever is left of the ${seatCount === 3 ? 'three' : 'four'}`),
          field('Starting coins', chips, 'Room coins only — they never touch your single-player purse'),
          skillField,
        ),
        el('p.field__hint.field__hint--block', preview),
        el('div.btn-row.btn-row--spaced',
          submit,
        ),
        status,
      ),
    );
  }

  async connect(url, timeoutMs) {
    if (!this.reachable()) throw new Error('This page was served over HTTPS and cannot reach a host on your network.');
    // close() clears the old client's handlers, so its late 'close' cannot
    // start a reconnect behind the new socket's back.
    this.client?.close();
    const client = new LanClient();
    this.client = client;
    this.url = url;
    this.needSync = true;
    this.session.client = client;
    client.on(S2C.ERROR, (message) => {
      if (message.code === 'resume_failed') this.onResumeFailed();
      else this.toast(String(message.message ?? ''));
    });
    client.on(S2C.ROOM, (message) => this.onRoom(message));
    client.on(S2C.VIEW, (message) => this.onView(message));
    client.on(S2C.EVENT, (message) => this.onEvent(message));
    client.on(S2C.RESULT, (message) => this.onResult(message));
    client.on('close', (info) => this.onDisconnect(client, info));
    await client.connect(url, timeoutMs);
    return client;
  }

  /**
   * First connection from the create/join form. The public host may be asleep:
   * wait for it (retrying quick refusals while it boots) and say why it is slow.
   * Resolves null when the screen was left in the meantime.
   */
  async connectFresh(url, status, attempt) {
    // connect() closes this.client, so a superseded loop must not reach it:
    // that socket may already be the one sitting in a room.
    const stale = () => this.unmounted || attempt !== this.formRun;
    if (!this.online) {
      if (stale()) return null;
      const client = await this.connect(url);
      if (stale()) {
        this.abandonAttempt(client);
        return null;
      }
      return client;
    }
    const notice = setTimeout(() => { if (!stale()) status.textContent = WAKE_NOTICE; }, WAKE_NOTICE_AFTER_MS);
    const deadline = Date.now() + ONLINE_FIRST_CONNECT_MS;
    try {
      for (;;) {
        if (stale()) return null;
        try {
          const client = await this.connect(url, Math.max(1_000, deadline - Date.now()));
          if (stale()) {
            this.abandonAttempt(client);
            return null;
          }
          return client;
        } catch (error) {
          if (stale()) return null;
          if (Date.now() + FIRST_CONNECT_RETRY_MS >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, FIRST_CONNECT_RETRY_MS));
        }
      }
    } finally {
      clearTimeout(notice);
    }
  }

  /** Close the socket a superseded form attempt opened, unless it has since joined a room. */
  abandonAttempt(client) {
    if (this.unmounted || (client === this.client && !this.room)) client.close();
  }

  startKeepAlive() {
    if (!this.online || this.keepAlive || !this.url) return;
    let target;
    try {
      target = healthUrlFor(this.url);
    } catch {
      return;
    }
    // no-cors: the answer is never read, the request only has to reach the host.
    this.keepAlive = setInterval(() => {
      fetch(target, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
    }, KEEP_ALIVE_MS);
  }

  stopKeepAlive() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
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
    text = String(text ?? '');
    // The table screen has no .footnote, so a refused play was silent.
    if (this.table) {
      if (this.tableGame === 'big2') {
        this.table.flashError(text);
        announce(text);
      } else this.setCaption(text);
      return;
    }
    const node = this.root.querySelector('.footnote');
    if (node) node.textContent = text;
    // A refusal before any room exists (bad code, full room) frees the form.
    this.reenable?.();
  }

  /**
   * An invite link opens on the default game; the room says what is really
   * being played. Keep the address bar and app params honest without
   * re-rendering or adding a history entry.
   */
  syncRoute() {
    const game = this.game;
    const params = this.app.params ?? {};
    if (params.gameId === game && !params.joinCode) return;
    const { joinCode, ...rest } = params;
    this.gameId = game;
    this.app.params = { ...rest, gameId: game, mode: this.mode };
    history.replaceState({ route: 'lan', params: this.app.params }, '', `#/lan/${game}/${this.mode}`);
  }

  onRoom(message) {
    const previousHost = this.room?.hostId;
    this.room = message.room;
    this.you = message.you;
    this.session.room = message.room;
    this.reenable = null;
    this.syncRoute();
    if (message.token) saveResume({ code: message.room.code, token: message.token, url: this.url });
    this.startKeepAlive();
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
    for (const node of this.root.querySelectorAll(':scope > .overlay, :scope > .b2-overlay')) node.remove();
  }

  onView(message) {
    const isBig2 = this.game === 'big2';
    // view.deal restarts at 0 every hand; the room's hand counter is what tells
    // one hand from the next. Big Two's view has no deal counter, so it keys on
    // the hand alone.
    const key = isBig2 ? `${message.hand ?? ''}` : `${message.hand ?? ''}:${message.view.deal}`;
    const firstOfDeal = key !== this.dealKey;
    this.dealKey = key;
    const resync = this.needSync;
    this.needSync = false;
    if (firstOfDeal) this.clearResult();
    this.view = message.view;
    if (!this.table) this.renderTable();
    if (isBig2) {
      this.onBig2View(message.view, firstOfDeal, resync);
      return;
    }
    this.table.update(message.view);
    // The host drives the hand, so the flourish runs alongside rather than
    // holding anything up. Only at the bidding stage: rejoining mid-play should
    // not replay a deal over a hand that is half played.
    if (firstOfDeal && message.view.phase === 'bidding') this.table.dealIn();
  }

  onBig2View(view, firstOfDeal, resync) {
    const table = this.table;
    // The play/pass EVENTs that led here were applied as they arrived. A new
    // hand or a fresh socket starts the felt clean instead.
    if (firstOfDeal || resync) table.resetTrick();
    table.update(view);
    // A (re)connect mid-hand missed the events, so show the play now standing.
    if (resync && view.trick) table.recordPlay(view.trick.seat, view.trick.combo, true);
    if (firstOfDeal && view.you?.hand?.length === 13 && !view.trick && !view.history?.length) table.dealIn();
  }

  onEvent(message) {
    const note = (seat, text) => {
      if (this.table?.say) this.table.say(seat, text);
      else if (this.table?.caption) this.table.caption(text);
      else announce(text);
    };
    if (message.kind === 'say') this.table?.say?.(message.seat, message.text);
    if (message.kind === 'left') note(message.seat, `${String(message.name ?? '')} left`);
    if (message.kind === 'back') note(message.seat, `${String(message.name ?? '')} is back`);
    // Without a view the table cannot place a seat on the felt yet; the first
    // VIEW redraws the standing play itself.
    if (this.tableGame !== 'big2' || !this.table || !this.view) return;
    if (message.kind === 'play') {
      const combo = classify(message.cards ?? []);
      if (combo) this.table.recordPlay(message.seat, combo, !!message.leading);
    } else if (message.kind === 'pass') {
      this.table.recordPass(message.seat, !!message.resolved);
    }
  }

  onResult(message) {
    if ((message.game ?? this.game) === 'big2') this.onBig2Result(message);
    else this.onDdzResult(message);
  }

  onDdzResult(message) {
    this.lastResult = message;
    const rows = message.rows.map(cleanRow);
    const mine = rows.find((row) => row.seat === this.view?.seat);
    if (!mine || !this.table) return;
    // A resume replays the last result; never stack two cards.
    this.resultOverlay?.remove();
    // Lines go through innerHTML, so every server value is coerced or escaped here.
    const lines = rows.map((row) =>
      `${row.seat === this.view.seat ? 'You' : escapeHtml(row.name)}: <span>${row.delta >= 0 ? '+' : '−'}${this.money(Math.abs(row.delta))}</span> → ${this.money(row.chips)}${row.capped ? ' (capped)' : ''}`);
    lines.unshift(`Winner: <span>${message.result?.landlordWon ? 'Landlord' : 'Farmers'}</span> at <span>×${Number(message.multiplier)}</span>`);
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

  onBig2Result(message) {
    this.lastResult = message;
    const clean = message.rows.map(cleanRow);
    const mine = clean.find((row) => row.seat === this.view?.seat);
    if (!mine || !this.table || this.tableGame !== 'big2') return;
    this.resultOverlay?.remove();
    const rows = clean.map((row) => ({
      name: row.seat === mine.seat ? `${row.name} (you)` : row.name,
      cardsLeft: row.cardsLeft,
      delta: row.delta,
      isWinner: row.seat === message.winner,
    }));
    const winner = clean.find((row) => row.seat === message.winner);
    // Lines go through innerHTML, so every server value is coerced or escaped here.
    const lines = [
      `Winner: <span>${escapeHtml(winner?.name ?? '—')}</span>${message.winner === mine.seat ? ' — you went out first' : ''}`,
      `Rate: <span>${this.money(Number(message.rate))}</span> per card left`,
      `Stack: <span>${this.money(mine.chips)}</span>`,
    ];
    const capped = clean.filter((row) => row.capped).map((row) => escapeHtml(row.name));
    if (capped.length) lines.splice(2, 0, `Paid only what they had: <span>${capped.join(', ')}</span>`);
    const isHost = this.room?.hostId === this.you;
    this.resultOverlay = this.table.showResult({
      title: mine.won ? 'You win' : 'You lose',
      win: mine.won,
      deltaText: `${mine.delta >= 0 ? '+' : '−'}${this.money(Math.abs(mine.delta))}`,
      rows,
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
    if (!this.room) {
      this.reenable?.();
      return;
    }
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
    const attemptTimeout = this.online ? ONLINE_RECONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      if (!this.isCurrent(run)) return;
      let outcome;
      try {
        const client = await this.connect(record.url, attemptTimeout);
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
    this.stopKeepAlive();
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
    this.stopKeepAlive();
    this.dropTable();
    this.shell(
      el('div.page__head',
        el('h1.page__title', this.online ? 'Can\'t reach the server' : 'Can\'t reach the host'),
        el('p.page__sub', 'The connection to the room dropped and could not be restored.'),
      ),
      el('div.btn-row',
        readResume() ? button('Try again', () => this.reconnect(), { class: 'btn--primary' }) : null,
        button(`Back to ${this.areaName}`, () => this.abandon()),
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
    this.stopKeepAlive();
    this.client?.close();
    this.dropTable();
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'Opened in another tab'),
        el('p.page__sub', 'This seat is now being played from another tab or window.'),
      ),
      el('div.btn-row',
        button(`Back to ${this.areaName}`, () => this.renderChoice(), { class: 'btn--primary' }),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  renderClosed() {
    this.stopKeepAlive();
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'That room has closed'),
        el('p.page__sub', 'The host closed the room, or your seat was given up while you were away.'),
      ),
      el('div.btn-row',
        button(`Back to ${this.areaName}`, () => this.renderChoice(), { class: 'btn--primary' }),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  dropTable() {
    this.table?.destroy();
    this.table = null;
    this.tableGame = null;
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
    this.stopKeepAlive();
    globalThis.document?.removeEventListener('visibilitychange', this.onWake);
    globalThis.removeEventListener('online', this.onWake);
    // Best effort: a seat left without a LEAVE frame is held for up to ten
    // minutes, then freed by the host's sweep.
    if (this.client?.connected) this.client.leave();
    this.client?.close();
    clearResume();
    this.dropTable();
  }

  /** Where friends open the page to land on the join screen with the code filled in. */
  inviteUrl(code) {
    return `${location.origin}${location.pathname}#/join/${code}`;
  }

  /** Native share sheet when there is one, else the clipboard, else select the text. */
  async shareInvite(url, shareButton, urlInput) {
    try {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Card Games', text: 'Join my table', url });
          return;
        } catch (error) {
          // The player closing the sheet is an answer, not a failure.
          if (error?.name === 'AbortError') return;
        }
      }
      await navigator.clipboard.writeText(url);
      shareButton.textContent = 'Link copied';
      setTimeout(() => { shareButton.textContent = 'Share link'; }, 2_000);
    } catch {
      urlInput.focus();
      urlInput.select();
    }
  }

  renderRoomLobby() {
    const room = this.room;
    const isHost = room.hostId === this.you;
    const hostInfo = this.client?.hostInfo;
    // Online rooms never show a LAN address, and neither does a public host.
    const showAddress = !this.online && !hostInfo?.public && !!hostInfo?.host;
    // The big line is the five characters people read out. The address belongs
    // underneath, for anyone whose page came from somewhere else.
    const fullCode = showAddress ? formatCode(room.code, hostInfo.host, hostInfo.port) : room.code;
    const seated = room.seats.filter((s) => s.id).length;
    const ready = seated >= 1;
    const game = room.settings.game === 'big2' ? 'big2' : 'doudizhu';
    const skills = skillsFor(game);

    const seatList = el('ul.seat-list');
    room.seats.forEach((seat) => {
      const bot = !seat.id;
      seatList.append(el('li', { class: seat.isHost ? 'is-host' : '' },
        el('span', `Seat ${seat.seat + 1}`),
        el('span', { style: 'flex:1' }, bot
          ? `Bot (${skills[room.settings.botSkill]?.name ?? room.settings.botSkill})`
          : (seat.connected === false ? `${String(seat.name)} (away)` : String(seat.name))),
        seat.isHost ? el('span', 'host') : null,
        el('span.seat-list__chips', seat.id ? this.money(seat.chips, true) : '—'),
      ));
    });

    let invite = null;
    if (this.online) {
      const url = this.inviteUrl(room.code);
      const urlInput = el('input.input', {
        readonly: true, value: url, 'aria-label': 'Invite link',
        onfocus: (event) => event.target.select(),
      });
      const shareButton = el('button.btn', { type: 'button' }, 'Share link');
      shareButton.addEventListener('click', () => this.shareInvite(url, shareButton, urlInput));
      invite = [
        el('p.room-url', 'Invite link'),
        el('div.invite-row', urlInput, shareButton),
      ];
    }

    const tiles = [statTile('Starting stack', this.money(room.settings.startingChips))];
    if (game === 'big2') tiles.push(statTile('Per card left', this.money(room.settings.pot / 10)));
    else tiles.push(statTile('Base stake', this.money(room.settings.pot), 'Per seat, before the multiplier'));

    this.shell(
      this.backLink('Leave room', () => this.leave()),
      el('div.page__head',
        el('h1.page__title', isHost ? 'Your room is open' : 'Waiting for the host'),
        el('p.page__sub', isHost
          ? (this.online ? 'Send the invite link, or read the code out.' : 'Read the code out. Everyone else opens this same address and joins.')
          : 'You are seated. The host starts the hand.'),
      ),
      el('div.card-panel',
        el('div.room-code', String(room.code)),
        this.online ? invite : el('p.room-url', showAddress
          ? `Everyone opens http://${hostInfo.host}:${hostInfo.port} on this network, then joins with ${room.code}. From another page, the full code is ${fullCode}.`
          : `Others join with ${room.code}`),
        seatList,
        el('div.stat-grid.stat-grid--spaced', ...tiles),
        el('div.btn-row.btn-row--spaced',
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
    const settings = this.room?.settings ?? defaultSettings(this.gameId);
    const mine = this.room?.seats.find((s) => s.id === this.you);
    // Mid-reconnect the new socket has not resumed yet, so a move would reach
    // the server as "not in a room" and overwrite the caption. Drop it.
    const guarded = (send) => (...args) => { if (!this.guardReconnecting()) send(...args); };
    if (this.game === 'big2') {
      this.tableGame = 'big2';
      this.table = new Big2View({
        root: this.root,
        meta: {
          lobbyName: `Room ${this.room?.code ?? ''}`,
          rateLabel: `Per card ${formatMoney(settings.pot / 10, settings.currency, true)}`,
          rate: settings.pot / 10,
          bankroll: mine?.chips ?? settings.startingChips,
          currency: settings.currency,
          animations: true,
        },
        handlers: {
          onPlay: guarded((cards) => this.client.play(cards)),
          onPass: guarded(() => this.client.pass()),
          onLeave: () => this.leave(),
        },
      });
    } else {
      this.tableGame = 'doudizhu';
      this.table = new TableView({
        root: this.root,
        meta: {
          lobbyName: `Room ${this.room?.code ?? ''}`,
          potLabel: formatMoney(settings.pot, settings.currency, true),
          bankroll: mine?.chips ?? settings.startingChips,
          baseMultiplier: settings.baseMultiplier,
          pot: settings.pot,
          capFactor: settings.capFactor,
          // The chips change between hands, so the table asks when it draws.
          stacksFor: (view) => {
            if (view.landlord < 0) return null;
            const stackOf = (seat) => this.room?.seats.find((s) => s.seat === seat)?.chips ?? settings.startingChips;
            const others = [0, 1, 2].filter((seat) => seat !== view.landlord);
            return { landlord: stackOf(view.landlord), farmers: others.map(stackOf) };
          },
          currency: settings.currency,
        },
        handlers: {
          onBid: guarded((value) => this.client.bid(value)),
          onPlay: guarded((cards) => this.client.play(cards)),
          onPass: guarded(() => this.client.pass()),
          onLeave: () => this.leave(),
        },
      });
    }
    if (this.view) this.table.update(this.view);
    this.onResize = () => { if (this.view) this.table?.renderHand(); };
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

function statTile(k, v, hint) {
  return el('div.stat', { title: hint }, el('div.stat__k', k), el('div.stat__v', v));
}

export { wait };
