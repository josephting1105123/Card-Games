/**
 * Menu, mode picker and lobby picker.
 *
 * Flow: menu -> pick a game -> single player or local multiplayer -> (solo) pick
 * a stake table, or (LAN) create or join a room.
 */

import { BANKRUPT_THRESHOLD, LOBBIES, RESCUE_EXIT, formatChips, lobbyAccess } from '../core/economy.js';
import { ratingTitle } from '../core/elo.js';
import { gameStats } from '../core/profile.js';
import { GAMES, gameById } from '../games/registry.js';
import { SKILLS } from '../games/doudizhu/ai.js';
import { clear, el } from './dom.js';

function topbar(app) {
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
          ? el('span.badge.badge--elo', `Elo ${stats.rating} · ${stats.played} played`)
          : el('span', ''),
      ),
    );
    tiles.append(tile);
  }

  const doudizhu = gameStats(profile, 'doudizhu');
  const record = el('div.card-panel',
    el('h2', { style: 'font-family:var(--serif);margin:0 0 12px;font-size:20px' }, 'Your record'),
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
        el('p.page__sub', 'Dou Di Zhu is dealt and ready. Big Two, Blackjack, Niu Niu and Texas Hold’em are queued behind it and keep their place in the list.'),
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
  const game = gameById(gameId);
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
        el('button.tile', { type: 'button', style: '--accent:#2f6fc8', onclick: () => app.go('lan', { gameId }) },
          el('span.tile__accent'),
          el('h2.tile__name', 'Local multiplayer'),
          el('p.tile__tag', 'Same network · room code'),
          el('p.tile__desc', 'One device hosts, everyone else joins with a code. The host sets the pot, the starting chips and how many seats the bots fill.'),
        ),
      ),
      el('div.rule'),
      el('div.card-panel',
        el('h2', { style: 'font-family:var(--serif);margin:0 0 10px;font-size:19px' }, 'House rules'),
        el('ul', { style: 'margin:0;padding-left:20px;line-height:1.75;color:#cfc9ba;font-size:14px' },
          ...(game.ruleNotes ?? []).map((note) => el('li', note)),
        ),
      ),
    ),
  );
}

export function renderLobby(app, root, gameId) {
  const game = gameById(gameId);
  const profile = app.profile;
  clear(root);
  const access = lobbyAccess(profile.bankroll, profile.rescueMode);
  const grid = el('div.lobbies');

  for (const { lobby, locked, reason } of access) {
    if (lobby.rescue && !profile.rescueMode) continue;
    const skill = SKILLS[lobby.skill];
    grid.append(el('button', {
      class: `lobby${lobby.rescue ? ' lobby--rescue' : ''}`,
      type: 'button',
      disabled: locked,
      onclick: () => app.go('table', { gameId, lobbyId: lobby.id }),
    },
      el('div.lobby__pot', formatChips(lobby.pot, true)),
      el('div.lobby__name', lobby.name),
      el('div.lobby__meta',
        el('span', `Base ×${lobby.baseMultiplier}`),
        el('span', `Bots: ${skill?.name ?? lobby.skill}`),
        el('span', lobby.rescue ? 'No entry fee' : `Entry ${formatChips(lobby.entry, true)}`),
        el('span', lobby.rescue ? 'No bankruptcy' : `Max loss ${formatChips(lobby.pot * lobby.capFactor, true)}`),
      ),
      el('p.lobby__blurb', lobby.blurb),
      locked ? el('p.lobby__lock', reason) : null,
    ));
  }

  root.append(
    topbar(app),
    el('main.page',
      el('button.back-link', { type: 'button', onclick: () => app.go('mode', { gameId }) }, `← ${game.name}`),
      el('div.page__head',
        el('h1.page__title', 'Choose a table'),
        el('p.page__sub', 'The pot is what each of the three seats puts up. Every table starts at a ×2 multiplier, doubled again by each bomb and by a spring; the landlord settles for twice a farmer.'),
      ),
      grid,
      el('div.rule'),
      el('div.card-panel',
        el('h2', { style: 'font-family:var(--serif);margin:0 0 10px;font-size:19px' }, 'How the caps work'),
        el('ul', { style: 'margin:0;padding-left:20px;line-height:1.75;color:#cfc9ba;font-size:14px' },
          el('li', 'A single hand can never take more than 60% of your chips, whatever the table.'),
          el('li', 'Each table also has its own ceiling: the pot times its cap factor.'),
          el('li', 'Winnings are never capped.'),
          el('li', `Below ${formatChips(BANKRUPT_THRESHOLD)} you move to the rescue table — 400 pot, no bankruptcy — until you hold ${formatChips(RESCUE_EXIT)}.`),
        ),
      ),
    ),
  );
}

export { LOBBIES };
