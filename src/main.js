/**
 * App shell and router.
 *
 * No framework and no build step: the whole thing is ES modules served as-is,
 * which is what makes it installable straight from GitHub Pages and runnable from
 * a folder on a laptop with nothing but Node for the LAN server.
 */

import { lobbyById } from './core/economy.js';
import { loadProfile, reconcileRescue, saveProfile } from './core/profile.js';
import { tableById as blackjackTableById } from './games/blackjack/tables.js';
import { BlackjackGame } from './ui/blackjack.js';
import { installCardDefs } from './ui/cardart.js';
import { clear, el } from './ui/dom.js';
import { renderLobby, renderMenu, renderMode } from './ui/screens.js';
import { SoloGame } from './ui/solo.js';

const root = document.getElementById('app');

const app = {
  profile: reconcileRescue(loadProfile()),
  route: 'menu',
  params: {},
  controller: null,
  go(route, params = {}) {
    this.teardown();
    this.route = route;
    this.params = params;
    const hash = `#/${route}${params.gameId ? `/${params.gameId}` : ''}${params.variant ? `/${params.variant}` : ''}${params.lobbyId ? `/${params.lobbyId}` : ''}`;
    if (location.hash !== hash) history.pushState({ route, params }, '', hash);
    this.render();
  },
  replace(route, params = {}) {
    this.teardown();
    this.route = route;
    this.params = params;
    this.render();
  },
  teardown() {
    if (this.controller?.unmount) this.controller.unmount();
    this.controller = null;
  },
  refreshChrome() {
    saveProfile(this.profile);
  },
  render() {
    clear(root);
    switch (this.route) {
      case 'mode':
        renderMode(this, root, this.params.gameId ?? 'doudizhu');
        break;
      case 'lobby':
        renderLobby(this, root, this.params.gameId ?? 'doudizhu', this.params.variant);
        break;
      case 'table': {
        const gameId = this.params.gameId ?? 'doudizhu';
        if (gameId === 'blackjack') {
          const table = blackjackTableById(this.params.lobbyId);
          if (!table) return this.replace('lobby', { gameId, variant: this.params.variant });
          const game = new BlackjackGame(this, { table, variant: this.params.variant });
          this.controller = game;
          game.mount(root);
          break;
        }
        const lobby = lobbyById(this.params.lobbyId);
        if (!lobby) return this.replace('lobby', { gameId });
        const game = new SoloGame(this, { lobby, gameId });
        this.controller = game;
        game.mount(root);
        break;
      }
      case 'lan':
      case 'lanroom':
        renderLoading(root, 'Loading local multiplayer…');
        import('./ui/lan.js')
          .then((mod) => mod.renderLan(this, root, this.params))
          .catch((error) => renderError(root, this, error));
        break;
      default:
        renderMenu(this, root);
    }
    document.documentElement.classList.toggle('at-table', this.route === 'table' || this.route === 'lanplay');
    window.scrollTo(0, 0);
    return undefined;
  },
};

function renderLoading(target, message) {
  clear(target);
  target.append(el('main.page', el('p.page__sub', message)));
}

function renderError(target, context, error) {
  clear(target);
  target.append(el('main.page',
    el('h1.page__title', 'That did not load'),
    el('p.page__sub', String(error?.message ?? error)),
    el('div.btn-row', el('button.btn', { type: 'button', onclick: () => context.go('menu') }, 'Back to the menu')),
  ));
}

window.addEventListener('popstate', (event) => {
  const state = event.state;
  if (state?.route) app.replace(state.route, state.params ?? {});
  else app.replace('menu');
});

installCardDefs();
history.replaceState({ route: 'menu', params: {} }, '', location.hash || '#/menu');

// A deep link straight to a table has no lobby in memory after a reload, so the
// router falls back to the picker rather than guessing.
const parts = (location.hash || '').replace(/^#\//, '').split('/');
if (parts[0] === 'mode' || parts[0] === 'lobby' || parts[0] === 'lan') {
  const gameId = parts[1] || 'doudizhu';
  const params = { gameId };
  // Only Blackjack's lobby route carries a variant segment (american/malaysian).
  if (gameId === 'blackjack' && parts[0] === 'lobby' && parts[2]) params.variant = parts[2];
  app.replace(parts[0], params);
} else {
  app.render();
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  });
}

globalThis.cardGames = app;
