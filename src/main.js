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
import { tableById as holdemTableById } from './games/holdem/tables.js';
import { clear, el } from './ui/dom.js';
import { renderLobby, renderMenu, renderMode } from './ui/screens.js';

const root = document.getElementById('app');

// A new worker has taken over and the page is still running the old build.
// Reloading is only safe on screens with no hand in progress, so on the others
// it waits until the player navigates back to one of these.
const RELOAD_SAFE_ROUTES = new Set(['menu', 'mode', 'lobby']);
let updateReady = false;
let reloading = false;

function reloadForUpdate() {
  if (reloading) return;
  reloading = true;
  location.reload();
}

const app = {
  profile: reconcileRescue(loadProfile()),
  route: 'menu',
  params: {},
  controller: null,
  // Bumped on every navigation so a lazy import that lands late can tell the
  // user has already moved on and drop its result instead of painting over it.
  nav: 0,
  go(route, params = {}) {
    this.nav += 1;
    this.teardown();
    this.route = route;
    this.params = params;
    const mode = route === 'lan' && params.mode ? `/${params.mode}` : '';
    const hash = `#/${route}${params.gameId ? `/${params.gameId}` : ''}${params.variant ? `/${params.variant}` : ''}${params.lobbyId ? `/${params.lobbyId}` : ''}${mode}`;
    if (location.hash !== hash) history.pushState({ route, params }, '', hash);
    this.render();
  },
  replace(route, params = {}) {
    this.nav += 1;
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
    // The hash is already updated by now, so the reload lands on this same screen.
    if (updateReady && RELOAD_SAFE_ROUTES.has(this.route)) {
      reloadForUpdate();
      return;
    }
    clear(root);
    switch (this.route) {
      case 'mode': {
        const gameId = this.params.gameId ?? 'doudizhu';
        // Only Blackjack keeps a mode step. An old #/mode/doudizhu bookmark or Back
        // entry lands on the table picker, with the address bar rewritten to match.
        if (gameId !== 'blackjack') {
          history.replaceState({ route: 'lobby', params: { gameId } }, '', `#/lobby/${gameId}`);
          return this.replace('lobby', { gameId });
        }
        renderMode(this, root, gameId);
        break;
      }
      case 'lobby':
        renderLobby(this, root, this.params.gameId ?? 'doudizhu', this.params.variant);
        break;
      case 'table': {
        const gameId = this.params.gameId ?? 'doudizhu';
        if (gameId === 'blackjack') {
          const table = blackjackTableById(this.params.lobbyId);
          // Back/forward can land on a rescue table the player has already left.
          if (!table || (table.rescue && !this.profile.rescueMode)) return this.replace('lobby', { gameId, variant: this.params.variant });
          mountTable(this, './ui/blackjack.js', (mod) => new mod.BlackjackGame(this, { table, variant: this.params.variant }));
          break;
        }
        if (gameId === 'texas') {
          const table = holdemTableById(this.params.lobbyId);
          if (!table) return this.replace('lobby', { gameId });
          mountTable(this, './ui/holdem.js', (mod) => new mod.HoldemGame(this, { table }));
          break;
        }
        const lobby = lobbyById(this.params.lobbyId);
        if (!lobby || (lobby.rescue && !this.profile.rescueMode)) return this.replace('lobby', { gameId });
        // Each table is its own module, so the menu never downloads the games it
        // did not open.
        if (gameId === 'big2') mountTable(this, './ui/big2.js', (mod) => new mod.BigTwoGame(this, { lobby, gameId }));
        else mountTable(this, './ui/solo.js', (mod) => new mod.SoloGame(this, { lobby, gameId }));
        break;
      }
      case 'lan':
      case 'lanroom':
        {
          // Same guard as mountTable: Back before the import lands must not let
          // the late screen paint over whatever the user navigated to.
          const nav = this.nav;
          const params = this.params;
          renderLoading(root, 'Loading local multiplayer…');
          import('./ui/lan.js')
            .then((mod) => {
              if (this.nav === nav) mod.renderLan(this, root, params);
            })
            .catch((error) => {
              if (this.nav === nav) renderError(root, this, error);
            });
        }
        break;
      default:
        renderMenu(this, root);
    }
    document.documentElement.classList.toggle('at-table', this.route === 'table' || this.route === 'lanplay');
    window.scrollTo(0, 0);
    return undefined;
  },
};

function mountTable(context, specifier, create) {
  const nav = context.nav;
  renderLoading(root, 'Dealing…');
  import(specifier)
    .then((mod) => {
      if (context.nav !== nav) return;
      const game = create(mod);
      context.controller = game;
      game.mount(root);
    })
    .catch((error) => {
      if (context.nav === nav) renderError(root, context, error);
    });
}

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

history.replaceState({ route: 'menu', params: {} }, '', location.hash || '#/menu');

// A deep link straight to a table has no lobby in memory after a reload, so the
// router falls back to the picker rather than guessing.
const parts = (location.hash || '').replace(/^#\//, '').split('/');
if (parts[0] === 'join') {
  // An invite link. The code goes to the lobby in memory only; the hash is
  // rewritten so a reload lands on the online screen instead of re-joining.
  const joinCode = (parts[1] || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const params = { gameId: 'doudizhu', mode: 'online' };
  history.replaceState({ route: 'lan', params }, '', '#/lan/doudizhu/online');
  app.replace('lan', joinCode ? { ...params, joinCode } : params);
} else if (parts[0] === 'mode' || parts[0] === 'lobby' || parts[0] === 'lan') {
  const gameId = parts[1] || 'doudizhu';
  const params = { gameId };
  // Only Blackjack's lobby route carries a variant segment (american/malaysian).
  if (gameId === 'blackjack' && parts[0] === 'lobby' && parts[2]) params.variant = parts[2];
  // The lan route's third segment is online or lan; anything else is ignored.
  if (parts[0] === 'lan' && (parts[2] === 'online' || parts[2] === 'lan')) params.mode = parts[2];
  app.replace(parts[0], params);
} else {
  app.render();
}

// The most common next tap is a Dou Di Zhu table. Fetch it once the menu has
// painted and the main thread is idle, so that tap finds it already loaded
// (solo.js pulls in tableview and the card art). Blackjack and Big Two stay on
// demand; warming all three would put back most of what lazy loading took out.
if (app.route === 'menu' || app.route === 'mode' || app.route === 'lobby') {
  const warm = () => {
    import('./ui/solo.js').catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 1500);
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // A first-time visitor has no controller, and the worker's clients.claim()
  // fires controllerchange for them too. That is not an update, so don't reload.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    updateReady = true;
    if (RELOAD_SAFE_ROUTES.has(app.route)) reloadForUpdate();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).then((registration) => {
      // An installed app that is only ever resumed never re-navigates, so the
      // browser's own update check never runs. Ask whenever it comes back.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

globalThis.cardGames = app;
