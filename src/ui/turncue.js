import { el } from './dom.js';

/** Fade starts here and the node is gone one fade later; matches --dur-slow plus slack. */
const HOLD_MS = 1000;
const GONE_MS = 1250;
/** --dur-med plus slack: how long a banner cut short by the turn passing lingers. */
const CUT_MS = 180;

/**
 * The "it is your turn" flash every table shares: a banner on the false -> true
 * edge, and for online rooms a buzz plus a tab-title marker while the tab is
 * in the background. Views call set() on every render, so everything keys off
 * the edge and a repeat call with the same turn does nothing.
 *
 * `host` has to be positioned: the banner is absolutely placed inside it.
 *
 * set() returns true when that call started a new banner (the false -> true
 * edge), so a view can measure where to put it once per banner.
 *
 * @returns {{ set(mine: boolean, label?: string): boolean, destroy(): void }}
 */
export function createTurnCue({ host, online = false }) {
  let destroyed = false;
  let wasMine = false;
  let banner = null;
  let holdTimer = 0;
  let goneTimer = 0;
  let savedTitle = null;
  let markedTitle = null;

  function dismiss() {
    clearTimeout(holdTimer);
    clearTimeout(goneTimer);
    holdTimer = goneTimer = 0;
    banner?.remove();
    banner = null;
  }

  /** The turn moved on while the banner was up: a stale "Your turn" would
   *  read as an instruction during the next player's move. */
  function cutShort() {
    if (!banner || banner.classList.contains('is-leaving') || banner.classList.contains('is-dismissed')) return;
    clearTimeout(holdTimer);
    clearTimeout(goneTimer);
    const mine = banner;
    // Dropping the entrance animation would snap opacity straight to 0 if it
    // is still running. Pin the live value first so the transition starts there.
    mine.style.opacity = getComputedStyle(mine).opacity;
    mine.classList.add('is-dismissed');
    void mine.offsetWidth;
    mine.style.opacity = '0';
    goneTimer = setTimeout(() => {
      if (banner === mine) dismiss();
    }, CUT_MS);
  }

  function flash(label) {
    // A fresh node restarts the enter animation; at most one banner exists.
    dismiss();
    banner = el('div.turncue', { role: 'status', 'aria-live': 'polite' }, label);
    host.append(banner);
    const mine = banner;
    holdTimer = setTimeout(() => mine.classList.add('is-leaving'), HOLD_MS);
    goneTimer = setTimeout(() => {
      if (banner === mine) dismiss();
    }, GONE_MS);
  }

  function markTitle() {
    if (savedTitle !== null) return;
    savedTitle = document.title;
    markedTitle = `● Your turn – ${savedTitle}`;
    document.title = markedTitle;
  }

  function restoreTitle() {
    if (savedTitle === null) return;
    // Another screen may have retitled the page since; do not stomp on that.
    if (document.title === markedTitle) document.title = savedTitle;
    savedTitle = markedTitle = null;
  }

  function onVisibility() {
    if (document.hidden) {
      // Still your turn when the tab goes to the background: mark it now.
      if (wasMine) markTitle();
    } else restoreTitle();
  }

  if (online) document.addEventListener('visibilitychange', onVisibility);

  return {
    set(mine, label = 'Your turn') {
      if (destroyed) return false;
      const edge = mine && !wasMine;
      wasMine = mine;
      if (!mine) {
        restoreTitle();
        cutShort();
        return false;
      }
      if (!edge) return false;
      flash(label);
      if (online) {
        try { navigator.vibrate?.(30); } catch { /* some browsers throw without a user gesture */ }
        if (document.hidden) markTitle();
      }
      return true;
    },

    destroy() {
      destroyed = true;
      dismiss();
      document.removeEventListener('visibilitychange', onVisibility);
      restoreTitle();
    },
  };
}
