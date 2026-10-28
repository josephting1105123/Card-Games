/**
 * Menu, mode picker and lobby picker.
 *
 * Flow: menu -> pick a game -> pick a stake table; "Play online" in the menu
 * header -> create or join a room.
 */

import {
  BANKRUPT_THRESHOLD, HAND_CAP_FACTOR, LOBBIES, MAX_LOSS_FRACTION, RESCUE_EXIT,
  formatChips, lobbyAccess,
} from '../core/economy.js';
import { ratingTitle } from '../core/elo.js';
import { cardFromId } from '../core/cards.js';
import { gameStats } from '../core/profile.js';
import { GAMES, READY_GAMES, gameById } from '../games/registry.js';
import { MAX_BUYIN_BB, minBuyIn, tableAccess } from '../games/holdem/tables.js';
import { SKILLS } from '../games/doudizhu/ai.js';
import { SKILLS as HOLDEM_SKILLS } from '../games/holdem/ai.js';
import { clear, el } from './dom.js';

// Static literal, no user data, so innerHTML is safe; el() only builds HTML-namespace nodes.
// The flask is the same mark the entropicsoftwarelabs.com header uses.
const MARK_SVG = '<svg viewBox="76 82 360 360" width="16" height="16" fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
  + '<mask id="mark-liquid"><path d="M216 104v104L128 372a32 32 0 0 0 28 48h200a32 32 0 0 0 28-48L296 208V104z" fill="#fff" stroke="none"/>'
  + '<path d="M216 104v104L128 372a32 32 0 0 0 28 48h200a32 32 0 0 0 28-48L296 208V104" stroke="#000" stroke-width="60"/></mask>'
  + '<rect x="0" y="310" width="512" height="202" fill="currentColor" stroke="none" mask="url(#mark-liquid)"/>'
  + '<path d="M216 104v104L128 372a32 32 0 0 0 28 48h200a32 32 0 0 0 28-48L296 208V104"/>'
  + '<path d="M196 104h120"/></svg>';

// aria-label because phones hide the second half of the visible text.
export function wordmark() {
  return el('a.wordmark', { href: 'https://entropicsoftwarelabs.com/', 'aria-label': 'Entropic Software Labs' },
    el('span.mark', { 'aria-hidden': 'true', html: MARK_SVG }),
    el('span.wordmark-text',
      el('span.wordmark-short', 'Entropic'),
      el('span.wordmark-rest', ' Software Labs'),
    ),
  );
}

export function topbar(app) {
  const profile = app.profile;
  return el('header.topbar',
    wordmark(),
    el('div.topbar__spacer'),
    el('div', { class: `chip-purse${profile.rescueMode ? ' is-rescue' : ''}` },
      el('span', formatChips(profile.bankroll)),
      el('small', profile.rescueMode ? 'rescue chips' : 'chips'),
    ),
  );
}

// Which cards each menu tile shows. Ids: 53 big joker, 48 two of spades, 3 three of
// diamonds, 44 ace of spades, 41 king of hearts.
const TILE_FANS = {
  doudizhu: { ids: [53, 48], opts: { style: 'bold' } },
  big2: { ids: [48, 3], opts: { style: 'bold' } },
  blackjack: { ids: [44, 41], opts: {} },
  texas: { ids: [44, 45], opts: { style: 'bold' } },
};

export function renderMenu(app, root) {
  clear(root);
  const profile = app.profile;
  const tiles = el('div.tiles.tiles--games');

  const fans = [];
  const heroFan = el('div.menu-hero__band', { 'aria-hidden': 'true' });
  fans.push({ fan: heroFan, spec: { ids: [53, 48, 44], opts: { style: 'bold' } } });
  for (const game of GAMES) {
    if (game.status !== 'ready') continue;
    const stats = gameStats(profile, game.id);
    const fan = el('span.tile__fan', { 'aria-hidden': 'true' });
    const spec = TILE_FANS[game.id];
    if (spec) fans.push({ fan, spec });
    const tile = el('button.tile.tile--game', { type: 'button', onclick: () => app.go(game.id === 'blackjack' ? 'mode' : 'lobby', { gameId: game.id }) },
      fan,
      el('div.tile__body',
        tileHead(game),
        el('div.tile__foot',
          el('div.tile__stats',
            game.noElo
              ? el('span', el('b', `${stats.played}`), ' played')
              : el('span', 'Elo ', el('b', `${stats.rating}`)),
            game.noElo
              ? el('span', `${stats.won} won · net ${formatChips(stats.net ?? 0)}`)
              : el('span', `${stats.played} played`),
          ),
          el('span.tile__cta', 'Play'),
        ),
      ),
    );
    tiles.append(tile);
  }

  // A div, not a button: nothing to press yet, and it stays out of the tab order.
  for (const game of GAMES) {
    if (game.status !== 'planned') continue;
    tiles.append(el('div.tile.tile--game.tile--soon',
      el('span.tile__fan', el('span.tile__soon', 'Coming soon')),
      el('div.tile__body', tileHead(game)),
    ));
  }

  // The card art is ~25 KB and only decoration, so it loads after the menu is up.
  // If the user has already moved on, or the import fails, the fans stay empty.
  const nav = app.nav;
  import('./cardart.js')
    .then(({ installCardDefs, cardElement }) => {
      if (app.nav !== nav) return;
      installCardDefs();
      for (const { fan, spec } of fans) {
        if (!fan.isConnected) continue;
        for (const id of spec.ids) fan.append(cardElement(cardFromId(id), spec.opts));
      }
    })
    .catch((error) => console.warn('Menu card art did not load', error));

  const readyCount = READY_GAMES.length;

  const doudizhu = gameStats(profile, 'doudizhu');
  const record = el('section.record',
    el('h2.panel__title', 'Your record'),
    el('div.stat-grid',
      stat('Chips', formatChips(profile.bankroll)),
      stat('Dou Di Zhu Elo', `${doudizhu.rating}`),
      stat('Title', ratingTitle(doudizhu.rating)),
      stat('Played', `${doudizhu.played}`),
      stat('Won', `${doudizhu.won}`),
      stat('Best streak', `${doudizhu.bestStreak}`),
    ),
  );

  root.append(
    topbar(app),
    el('main.page',
      el('div.page__head.menu-hero',
        el('div.menu-hero__text',
          el('span.eyebrow', 'Card room'),
          el('h1.page__title.page__title--display', 'Pick a game'),
          el('p.page__sub',
            `${NUMBER_WORDS[readyCount] ?? readyCount} game${readyCount === 1 ? '' : 's'} ready to deal, against the house bots or with friends online. No account, and it keeps working offline once installed.`),
          el('div.menu-hero__actions',
            el('button.btn.btn--primary', { type: 'button', onclick: () => app.go('lan', { gameId: 'doudizhu', mode: 'online' }) }, 'Play online'),
            el('span.menu-hero__hint', 'Create a room or join one with a code'),
          ),
        ),
        heroFan,
      ),
      profile.rescueMode
        ? el('div.notice.notice--warn',
            el('b', 'You are on rescue chips. '),
            `Dou Di Zhu and Big Two are limited to the 400-pot rescue table, and Blackjack's rescue table takes bets with no chips, until you hold ${formatChips(RESCUE_EXIT)}.`)
        : null,
      tiles,
      record,
      el('p.footnote',
        'Chips are local to this device. Add the page to your home screen to play offline.'),
    ),
  );
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

// Name, tagline and blurb are the same on a playable tile and a coming-soon one.
function tileHead(game) {
  return [
    el('h2.tile__name', game.name, game.nameZh ? el('span.tile__zh', game.nameZh) : null),
    el('p.tile__tag', `${game.tagline} · ${game.players} player${game.players > 1 ? 's' : ''}`),
    el('p.tile__desc', game.description),
  ];
}

function stat(k, v) {
  return el('div.stat', el('div.stat__k', k), el('div.stat__v', v));
}

// Blackjack's screens live in the 70 KB blackjack module, which the menu has no
// other use for, so it loads on first visit. app.nav moves on every navigation;
// if it changed while the import was in flight the user has left, and painting
// now would land on top of whatever screen they are on.
function renderBlackjackScreen(app, root, paint) {
  const nav = app.nav;
  clear(root);
  root.append(topbar(app), el('main.page', el('p.page__sub', 'Loading Blackjack…')));
  import('./blackjack.js')
    .then((mod) => {
      if (app.nav === nav) paint(mod);
    })
    .catch((error) => {
      if (app.nav !== nav) return;
      clear(root);
      root.append(topbar(app), el('main.page',
        el('h1.page__title', 'That did not load'),
        el('p.page__sub', String(error?.message ?? error)),
        el('div.btn-row', el('button.btn', { type: 'button', onclick: () => app.go('menu') }, 'Back to the menu')),
      ));
    });
}

export function renderMode(app, root, gameId) {
  if (gameId === 'blackjack') return renderBlackjackScreen(app, root, (mod) => mod.renderBlackjackMode(app, root));
  // Only Blackjack still has a mode step (American or Malaysian). main.js redirects
  // other games before this runs; this keeps a direct call from rendering nothing.
  return renderLobby(app, root, gameId);
}

export function renderLobby(app, root, gameId, variant) {
  if (gameId === 'blackjack') return renderBlackjackScreen(app, root, (mod) => mod.renderBlackjackLobby(app, root, variant));
  if (gameId === 'texas') return renderHoldemLobby(app, root);
  const game = gameById(gameId);
  const profile = app.profile;
  const isBig2 = gameId === 'big2';
  clear(root);
  const access = lobbyAccess(profile.bankroll, profile.rescueMode);
  const grid = el('div.lobbies');

  for (const { lobby, locked, reason } of access) {
    if (lobby.rescue && !profile.rescueMode) continue;
    const skill = SKILLS[lobby.skill];
    // F4: Big Two has no pot-times-multiplier stake, only a per-card rate
    // (F1: rate = lobby.pot / 10) — the lobby card leads with that instead.
    const meta = isBig2
      ? [
          el('span', `Bots: ${skill?.name ?? lobby.skill}`),
          el('span', lobby.rescue ? 'No entry fee' : `Entry ${formatChips(lobby.entry, true)}`),
        ]
      : [
          el('span', `Base ×${lobby.baseMultiplier}`),
          el('span', `Bots: ${skill?.name ?? lobby.skill}`),
          el('span', lobby.rescue ? 'No entry fee' : `Entry ${formatChips(lobby.entry, true)}`),
          el('span', lobby.rescue ? 'No bankruptcy' : `Hand ceiling ${formatChips(lobby.pot * lobby.capFactor, true)}`),
        ];
    grid.append(el('button', {
      class: `lobby${lobby.rescue ? ' lobby--rescue' : ''}`,
      type: 'button',
      disabled: locked,
      onclick: () => app.go('table', { gameId, lobbyId: lobby.id }),
    },
      isBig2
        ? el('div.lobby__pot', formatChips(lobby.pot / 10, true), el('small', 'per card'))
        : el('div.lobby__pot', formatChips(lobby.pot, true)),
      el('div.lobby__name', lobby.name),
      el('div.lobby__meta', ...meta),
      el('p.lobby__blurb', lobby.blurb),
      locked ? el('p.lobby__lock', reason) : null,
    ));
  }

  const sub = isBig2
    ? 'The pot sets the rate: each card left in a loser’s hand pays a tenth of it to whoever went out first. No multiplier — a hand is worth the same whether it ends on the first trick or the last.'
    : 'The pot is what each of the three seats puts up. Every table starts at ×2. The points called multiply it, and each bomb, rocket and spring doubles it again; the landlord settles for twice a farmer.';
  const capsNotes = isBig2
    ? [
        el('li', `No single hand moves more than ${HAND_CAP_FACTOR} pots, won or lost — a backstop for the rare hand where a loser is left holding most of a deck.`),
        el('li', `Losses are held down a second time: never more than ${Math.round(MAX_LOSS_FRACTION * 100)}% of what you hold, so one hand cannot wipe you out.`),
        el('li', 'Winnings are not held down that way. A win you could not have afforded to lose is the one worth having.'),
        el('li', `Below ${formatChips(BANKRUPT_THRESHOLD)} you move to the rescue table — 400 pot, no bankruptcy — until you hold ${formatChips(RESCUE_EXIT)}.`),
      ]
    : [
        el('li', `No single hand moves more than ${HAND_CAP_FACTOR} pots, won or lost. The landlord risks twice a farmer, so that ceiling only bites past a multiplier of ${HAND_CAP_FACTOR / 2} — in practice ×32 or more. Every ordinary bomb hand pays in full.`),
        el('li', `Losses are held down a second time: never more than ${Math.round(MAX_LOSS_FRACTION * 100)}% of what you hold, so one hand cannot wipe you out.`),
        el('li', 'Winnings are not held down that way. A win you could not have afforded to lose is the one worth having.'),
        el('li', `Below ${formatChips(BANKRUPT_THRESHOLD)} you move to the rescue table — 400 pot, no bankruptcy — until you hold ${formatChips(RESCUE_EXIT)}.`),
      ];

  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('menu') }, '← All games'),
      el('div.page__head',
        el('span.eyebrow', game.name, game.nameZh ? ` ${game.nameZh}` : ''),
        el('h1.page__title', 'Choose a table'),
        el('p.page__sub', sub),
      ),
      grid,
      el('div.rule'),
      el('div.card-panel',
        el('h2.panel__title', 'How the caps work'),
        el('ul.panel__list', ...capsNotes),
      ),
      el('div.rule'),
      el('div.card-panel',
        el('h2.panel__title', 'House rules'),
        el('ul.panel__list',
          ...(game.ruleNotes ?? []).map((note) => el('li', note)),
        ),
      ),
    ),
  );
}

// Hold'em tables are priced by blinds, not by a pot, so they have their own picker.
function renderHoldemLobby(app, root) {
  const game = gameById('texas');
  const profile = app.profile;
  clear(root);
  const grid = el('div.lobbies');
  for (const { table, locked, reason } of tableAccess(profile.bankroll)) {
    grid.append(el('button', {
      class: 'lobby',
      type: 'button',
      disabled: locked,
      onclick: () => app.go('table', { gameId: 'texas', lobbyId: table.id }),
    },
      el('div.lobby__pot', `${formatChips(table.sb, true)}/${formatChips(table.bb, true)}`, el('small', 'blinds')),
      el('div.lobby__name', table.name),
      el('div.lobby__meta',
        el('span', `Bots: ${HOLDEM_SKILLS[table.skill]?.name ?? table.skill}`),
        el('span', `Buy-in up to ${formatChips(table.bb * MAX_BUYIN_BB, true)}`),
        el('span', `Min ${formatChips(minBuyIn(table), true)}`)),
      el('p.lobby__blurb', table.blurb),
      locked ? el('p.lobby__lock', reason) : null,
    ));
  }
  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('menu') }, '← All games'),
      el('div.page__head',
        el('span.eyebrow', game.name),
        el('h1.page__title', 'Choose a table'),
        el('p.page__sub', `You sit down with up to ${MAX_BUYIN_BB} big blinds, or your whole bankroll if that is less. Whatever you win or lose over the session comes straight out of your chips, so a bust costs you the buy-in and nothing more.`),
      ),
      grid,
      el('div.rule'),
      el('div.card-panel',
        el('h2.panel__title', 'House rules'),
        el('ul.panel__list', ...(game.ruleNotes ?? []).map((note) => el('li', note))),
      ),
    ),
  );
}

export { LOBBIES };
