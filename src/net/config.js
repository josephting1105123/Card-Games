/**
 * Where the browser finds the online host.
 *
 * No DOM here: callers pass `location` in, so the node tests (and anything else
 * without a page) can exercise it.
 */

export const ONLINE_SOCKET_URL = 'wss://cards.entropicsoftwarelabs.com/lan';

const SERVER_KEY = 'card-games.server';

/**
 * The override is a developer aid, so only a page served from this machine may
 * use it. On the public deploy a crafted invite link could otherwise point the
 * app at someone else's server and read the player's name and room traffic.
 */
function isLocalPage(location) {
  const host = String(location?.hostname ?? '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost');
}

function readOverride(location) {
  if (!isLocalPage(location)) {
    // Drop anything an earlier visit stored, so it cannot outlive the check.
    try {
      globalThis.sessionStorage?.removeItem(SERVER_KEY);
    } catch { /* storage blocked: nothing was stored */ }
    return null;
  }
  const fromQuery = new URLSearchParams(location?.search ?? '').get('server');
  if (fromQuery && /^wss?:\/\//i.test(fromQuery)) {
    try {
      globalThis.sessionStorage?.setItem(SERVER_KEY, fromQuery);
    } catch { /* storage blocked: the override just will not outlive this load */ }
    return fromQuery;
  }
  try {
    const stored = globalThis.sessionStorage?.getItem(SERVER_KEY);
    return stored && /^wss?:\/\//i.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * ?server=wss://… wins on a local page only (and is remembered for this tab, so
 * the invite hash and reloads keep using it); a page served over http is a LAN or local host, which
 * is its own server; otherwise the public deploy.
 */
export function onlineSocketUrl(location) {
  const override = readOverride(location);
  if (override) return override;
  if (location?.protocol === 'http:') return `ws://${location.host}/lan`;
  return ONLINE_SOCKET_URL;
}

/** The keep-alive target for a socket URL: wss -> https, ws -> http, path /healthz. */
export function healthUrlFor(socketUrl) {
  const url = new URL(socketUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/healthz';
  url.search = '';
  url.hash = '';
  return url.toString();
}
