/**
 * App shell and router.
 *
 * No framework and no build step: the whole thing is ES modules served as-is,
 * which is what makes it installable straight from GitHub Pages and runnable from
 * a folder on a laptop with nothing but Node for the LAN server.
 */

import { lobbyById } from './core/economy.js';
import { loadProfile, reconcileRescue, saveProfile } from './core/profile.js';
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
    const hash = `#/${route}${params.gameId ? `/${params.gameId}` : ''}${params.lobbyId ? `/${params.lobbyId}` : ''}`;
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
        renderLobby(this, root, this.params.gameId ?? 'doudizhu');
        break;
      case 'table': {
        const lobby = lobbyById(this.params.lobbyId);
        if (!lobby) return this.replace('lobby', { gameId: this.params.gameId ?? 'doudizhu' });
        const game = new SoloGame(this, { lobby, gameId: this.params.gameId ?? 'doudizhu' });
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
  app.replace(parts[0], { gameId: parts[1] || 'doudizhu' });
} else {
  app.render();
}

/**
 * Service worker: register it, and keep it current.
 *
 * sw.js calls skipWaiting() and clients.claim() on its own, so a newly
 * installed worker takes control the instant it activates — nothing here has
 * to ask for that part. What nothing here did, until now, is ever ask
 * *whether* a new worker exists. The browser normally rechecks sw.js on a
 * navigation, but this is a hash-routed single-page app: a tab left open, or
 * a PWA launched straight back into its last route, never issues one. So this
 * drives that check itself (on start, and whenever the tab comes back into
 * view), and gates the reload a new worker implies on whether a hand is in
 * progress — the felt is the one place a silent refresh costs a trick.
 */

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // don't hammer registration.update()
const RELOAD_COOLDOWN_MS = 10 * 1000; // survives the reload itself, so a bad deploy can't loop
const RELOAD_GUARD_KEY = 'cardgames:sw-reload-at';

let swRegistration = null;
let lastUpdateCheck = 0;
let updateWaiting = false;
let reloaded = false;
let updatePill = null;

/** Mid-hand: at the table, and no result screen up yet. */
function inMatch() {
  if (!document.documentElement.classList.contains('at-table')) return false;
  return !root.querySelector('.result');
}

function recentlyAutoReloaded() {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    return at > 0 && Date.now() - at < RELOAD_COOLDOWN_MS;
  } catch {
    return false; // private mode etc. — worst case we lose the loop guard, not the app
  }
}

function showUpdatePill() {
  if (!updatePill) {
    updatePill = el('div.update-pill', { role: 'status', 'aria-live': 'polite' },
      'An update is ready — it will load once you leave the table.');
    document.body.append(updatePill);
  }
  updatePill.classList.add('is-visible');
}

/** Apply a waiting update now, or hold it until the match is no longer live. */
function applyUpdate() {
  if (reloaded || recentlyAutoReloaded()) return;
  if (inMatch()) {
    updateWaiting = true;
    showUpdatePill();
    return;
  }
  reloaded = true; // exactly one reload per update, so a bad deploy can't loop
  try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { /* see above */ }
  location.reload();
}

function maybeCheckForUpdate() {
  if (!swRegistration) return;
  const now = Date.now();
  if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheck = now;
  swRegistration.update().catch(() => {});
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url))
      .then((reg) => {
        swRegistration = reg;
        lastUpdateCheck = Date.now();
        reg.update().catch(() => {}); // ask once up front, beyond whatever the browser does on register
      })
      .catch(() => {});
  });

  // The new worker has already skipped waiting and claimed every client by the
  // time this fires; the page below it is still running the old JS and CSS.
  navigator.serviceWorker.addEventListener('controllerchange', () => applyUpdate());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    maybeCheckForUpdate();
    if (updateWaiting) applyUpdate(); // the match may have ended while the tab was hidden
  });

  // render() only rebuilds #app on a route change; showResult() also appends
  // straight into it when a hand settles with no route change at all. Either
  // one is a sign the "hold until the match ends" condition may just have
  // lifted, so re-check on any change to the app root rather than routing.
  new MutationObserver(() => {
    if (updateWaiting) applyUpdate();
  }).observe(root, { childList: true, subtree: true });
}

globalThis.cardGames = app;
