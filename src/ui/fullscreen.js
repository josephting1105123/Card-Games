/**
 * Fullscreen for tables played in a phone browser, where the address/tab bar
 * otherwise eats ~15% of the viewport.
 *
 * Generic on purpose: Dou Di Zhu wires this in today, Blackjack's table wires
 * the same module in afterwards. Nothing here knows what a "table" contains.
 */

/** True once, from the very first pointerdown, then never asked again. */
function alreadyImmersive() {
  return globalThis.matchMedia?.('(display-mode: fullscreen)')?.matches
    || globalThis.matchMedia?.('(display-mode: standalone)')?.matches;
}

function hasCoarsePointer() {
  return !!globalThis.matchMedia?.('(pointer: coarse)')?.matches;
}

/**
 * @param {HTMLElement} tableEl  the element to put into fullscreen
 * @param {HTMLElement} hudHost  where the fullscreen toggle button lives
 * @returns {() => void} teardown — removes the listener and the button
 */
export function enableTableFullscreen(tableEl, hudHost) {
  const doc = globalThis.document;
  const api = doc?.documentElement && typeof doc.documentElement.requestFullscreen === 'function';

  // A first tap/click asks for fullscreen (and landscape) once, silently
  // giving up if the browser refuses — Safari on iPhone has no fullscreen API
  // at all, and a user gesture is required, which is exactly what this is.
  let askedOnce = false;
  const onFirstPointerDown = () => {
    if (askedOnce) return;
    askedOnce = true;
    if (!api || alreadyImmersive() || !hasCoarsePointer()) return;
    doc.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => globalThis.screen?.orientation?.lock?.('landscape')?.catch(() => {}))
      .catch(() => {});
  };
  tableEl.addEventListener('pointerdown', onFirstPointerDown);

  // The toggle stays hidden when the API does not exist at all (iPhone
  // Safari): a button that can never do anything is worse than no button.
  let teardownButton = null;
  if (api) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'fullscreen-toggle';
    button.setAttribute('aria-label', 'Toggle fullscreen');
    button.title = 'Toggle fullscreen';
    button.textContent = '⛶';
    const sync = () => button.classList.toggle('is-on', !!doc.fullscreenElement);
    const onClick = () => {
      if (doc.fullscreenElement) {
        doc.exitFullscreen?.().catch(() => {});
      } else {
        tableEl.requestFullscreen?.({ navigationUI: 'hide' })
          .then(() => globalThis.screen?.orientation?.lock?.('landscape')?.catch(() => {}))
          .catch(() => {});
      }
    };
    button.addEventListener('click', onClick);
    doc.addEventListener('fullscreenchange', sync);
    sync();
    hudHost.appendChild(button);

    teardownButton = () => {
      button.removeEventListener('click', onClick);
      doc.removeEventListener('fullscreenchange', sync);
      button.remove();
    };
  }

  return () => {
    tableEl.removeEventListener('pointerdown', onFirstPointerDown);
    teardownButton?.();
  };
}
