/**
 * Menu, mode picker and lobby picker.
 *
 * Flow: menu -> pick a game -> single player or local multiplayer -> (solo) pick
 * a stake table, or (LAN) create or join a room.
 */

import {
  BANKRUPT_THRESHOLD, HAND_CAP_FACTOR, LOBBIES, MAX_LOSS_FRACTION, RESCUE_EXIT,
  formatChips, lobbyAccess,
} from '../core/economy.js';
import { ratingTitle } from '../core/elo.js';
import { gameStats } from '../core/profile.js';
import { GAMES, gameById } from '../games/registry.js';
import { SKILLS } from '../games/doudizhu/ai.js';
import { clear, el } from './dom.js';
import { renderBlackjackLobby, renderBlackjackMode } from './blackjack.js';

export function topbar(app) {
  const profile = app.profile;
  return el('header.topbar',
    el('div.topbar__brand', el('span.topbar__suits', '♠♥♣♦'), el('b', 'Card Games')),
    el('div.topbar__spacer'),
    el('div', { class: `chip-purse${profile.rescueMode ? ' is-rescue' : ''}` },
      el('small', profile.rescueMode ? 'Rescue' : 'Chips'),
      el('span', formatChips(profile.bankroll)),
    ),
  );
}

export function renderMenu(app, root) {
  clear(root);
  const profile = app.profile;
  const tiles = el('div.tiles');

  for (const game of GAMES) {
    const ready = game.status === 'ready';
    const stats = ready ? gameStats(profile, game.id) : null;
    const tile = el(ready ? 'button.tile' : 'div.tile.tile--locked', {
      style: `--accent:${game.accent}`,
      ...(ready ? { type: 'button', onclick: () => app.go('mode', { gameId: game.id }) } : {}),
    },
      el('span.tile__accent'),
      el('h2.tile__name', game.name, game.nameZh ? el('span.tile__zh', game.nameZh) : null),
      el('p.tile__tag', `${game.tagline} · ${game.players} player${game.players > 1 ? 's' : ''}`),
      el('p.tile__desc', game.description),
      el('div.tile__foot',
        el('span', { class: `badge ${ready ? 'badge--ready' : 'badge--soon'}` }, ready ? 'Playable' : 'Planned'),
        stats
          ? el('span.badge.badge--elo', game.noElo
              ? `Played ${stats.played} · Won ${stats.won} · Net ${formatChips(stats.net ?? 0)}`
              : `Elo ${stats.rating} · ${stats.played} played`)
          : el('span', ''),
      ),
    );
    tiles.append(tile);
  }

  const doudizhu = gameStats(profile, 'doudizhu');
  const record = el('div.card-panel',
    el('h2', { style: 'font-family:var(--font);margin:0 0 12px;font-size:20px' }, 'Your record'),
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
      el('div.page__head',
        el('h1.page__title', 'Pick a game'),
        el('p.page__sub', 'Dou Di Zhu, Big Two and Blackjack are dealt and ready. Niu Niu and Texas Hold’em are queued behind them and keep their place in the list.'),
      ),
      profile.rescueMode
        ? el('div.notice.notice--warn',
            el('b', 'You are at the rescue table. '),
            `Only the 400 pot is open, losses cannot take you below zero, and the normal rooms unlock again at ${formatChips(RESCUE_EXIT)}.`)
        : null,
      tiles,
      el('div.rule'),
      record,
      el('p.footnote', { style: 'margin-top:18px' },
        'Chips are local to this device. Add the page to your home screen to play offline.'),
    ),
  );
}

function stat(k, v) {
  return el('div.stat', el('div.stat__k', k), el('div.stat__v', v));
}

export function renderMode(app, root, gameId) {
  if (gameId === 'blackjack') return renderBlackjackMode(app, root);
  const game = gameById(gameId);
  // Big Two is single-player only so far — F4: the tile stays put and says
  // so, rather than disappearing, the same way a planned game's menu tile does.
  const lanReady = gameId !== 'big2';
  clear(root);
  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('menu') }, '← All games'),
      el('div.page__head',
        el('h1.page__title', game.name, game.nameZh ? el('span.tile__zh', game.nameZh) : null),
        el('p.page__sub', game.description),
      ),
      el('div.tiles',
        el('button.tile', { type: 'button', style: '--accent:#cdae6c', onclick: () => app.go('lobby', { gameId }) },
          el('span.tile__accent'),
          el('h2.tile__name', 'Single player'),
          el('p.tile__tag', 'Against the house bots'),
          el('p.tile__desc', 'Pick a stake table. The bots get sharper as the pot grows, your chips and Elo are on the line, and a cap limits what any one hand can cost you.'),
        ),
        el(lanReady ? 'button.tile' : 'div.tile.tile--locked', {
          style: '--accent:#2f6fc8',
          ...(lanReady ? { type: 'button', onclick: () => app.go('lan', { gameId }) } : {}),
        },
          el('span.tile__accent'),
          el('h2.tile__name', 'Local multiplayer'),
          el('p.tile__tag', lanReady ? 'Same network · room code' : 'Coming later'),
          el('p.tile__desc', lanReady
            ? 'One device hosts, everyone else joins with a code. The host sets the pot, the starting chips and how many seats the bots fill.'
            : 'Single player first. The same room-code hosting Dou Di Zhu uses is next for this table.'),
        ),
      ),
      el('div.rule'),
      el('div.card-panel',
        el('h2', { style: 'font-family:var(--font);margin:0 0 10px;font-size:19px' }, 'House rules'),
        el('ul', { style: 'margin:0;padding-left:20px;line-height:1.75;color:#cfc9ba;font-size:14px' },
          ...(game.ruleNotes ?? []).map((note) => el('li', note)),
        ),
      ),
    ),
  );
}

export function renderLobby(app, root, gameId, variant) {
  if (gameId === 'blackjack') return renderBlackjackLobby(app, root, variant);
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
        ? el('div.lobby__pot', `Per card ${formatChips(lobby.pot / 10, true)}`)
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
      el('button.back-link', { type: 'button', onclick: () => app.go('mode', { gameId }) }, `← ${game.name}`),
      el('div.page__head',
        el('h1.page__title', 'Choose a table'),
        el('p.page__sub', sub),
      ),
      grid,
      el('div.rule'),
      el('div.card-panel',
        el('h2', { style: 'font-family:var(--font);margin:0 0 10px;font-size:19px' }, 'How the caps work'),
        el('ul', { style: 'margin:0;padding-left:20px;line-height:1.75;color:#cfc9ba;font-size:14px' }, ...capsNotes),
      ),
    ),
  );
}

export { LOBBIES };
