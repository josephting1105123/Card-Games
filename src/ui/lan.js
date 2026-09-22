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
import { button, clear, el, field, numberInput, select, wait } from './dom.js';

const NAME_KEY = 'card-games.lan-name';

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
  }

  start() {
    this.renderChoice();
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
          field('Base multiplier', mult, 'The floor; bombs and springs double it'),
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

  async connect(url) {
    if (!lanReachable()) throw new Error('This page was served over HTTPS and cannot reach a host on your network.');
    this.client?.close();
    const client = new LanClient();
    this.client = client;
    this.session.client = client;
    client.on(S2C.ERROR, (message) => this.toast(message.message));
    client.on(S2C.ROOM, (message) => this.onRoom(message));
    client.on(S2C.VIEW, (message) => this.onView(message));
    client.on(S2C.EVENT, (message) => this.onEvent(message));
    client.on(S2C.RESULT, (message) => this.onResult(message));
    client.on('close', () => this.onDisconnect());
    await client.connect(url);
    return client;
  }

  toast(text) {
    const node = this.root.querySelector('.footnote') ?? this.root;
    if (node === this.root) return;
    node.textContent = text;
  }

  onRoom(message) {
    this.room = message.room;
    this.you = message.you;
    this.session.room = message.room;
    if (this.room.phase === 'lobby') this.renderRoomLobby();
    else if (!this.table) this.renderTable();
    else this.updateTableMeta();
  }

  onView(message) {
    this.view = message.view;
    if (!this.table) this.renderTable();
    this.table.update(message.view);
  }

  onEvent(message) {
    if (message.kind === 'say') this.table?.say(message.seat, message.text);
    if (message.kind === 'left') this.table?.say(message.seat, `${message.name} left`);
  }

  onResult(message) {
    const mine = message.rows.find((row) => row.seat === this.view?.seat);
    if (!mine || !this.table) return;
    const lines = message.rows.map((row) =>
      `${row.seat === this.view.seat ? 'You' : row.name}: <span>${row.delta >= 0 ? '+' : '−'}${this.money(Math.abs(row.delta))}</span> → ${this.money(row.chips)}${row.capped ? ' (capped)' : ''}`);
    lines.unshift(`Winner: <span>${message.result.landlordWon ? 'Landlord' : 'Farmers'}</span> at <span>×${message.multiplier}</span>`);
    const isHost = this.room?.hostId === this.you;
    this.table.showResult({
      title: mine.won ? 'You win' : 'You lose',
      win: mine.won,
      deltaText: `${mine.delta >= 0 ? '+' : '−'}${this.money(Math.abs(mine.delta))}`,
      lines,
      againLabel: isHost ? 'Deal again' : 'Waiting for the host',
      onAgain: () => (isHost ? this.client.again() : null),
      onLeave: () => this.leave(),
    });
  }

  onDisconnect() {
    if (this.left) return;
    this.shell(
      el('div.page__head',
        el('h1.page__title', 'The host went away'),
        el('p.page__sub', 'The connection to the room closed. The host may have stopped the server or left the network.'),
      ),
      el('div.btn-row',
        button('Back to local multiplayer', () => this.renderChoice(), { class: 'btn--primary' }),
        button('Main menu', () => this.app.go('menu')),
      ),
    );
  }

  leave() {
    this.left = true;
    this.client?.close();
    this.app.go('menu');
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
        el('span', { style: 'flex:1' }, bot ? `Bot (${SKILLS[room.settings.botSkill]?.name ?? room.settings.botSkill})` : seat.name),
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
        onBid: (value) => this.client.bid(value),
        onPlay: (cards) => this.client.play(cards),
        onPass: () => this.client.pass(),
        onLeave: () => this.leave(),
      },
    });
    if (this.view) this.table.update(this.view);
    this.onResize = () => this.table?.renderHand();
    globalThis.addEventListener('resize', this.onResize);
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
