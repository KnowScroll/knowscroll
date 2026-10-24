/** Longest wait when no Back turns out to be pending. */
const FALLBACK_MS = 400;

/**
 * Runs `run` once a Back the app has just asked the browser for has landed.
 *
 * The encounter keeps one transient history entry while a sheet is open and removes it with a single
 * `history.back()` when the sheet closes. That Back is asynchronous: an address pushed before it
 * lands is popped again and the person stays where they were. So a sheet that closes and then opens
 * another screen navigates from here. If no Back is pending, `run` starts after `FALLBACK_MS`.
 */
export function afterPendingBack(run: () => void): void {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    window.removeEventListener('popstate', start);
    clearTimeout(timer);
    run();
  };
  const timer = setTimeout(start, FALLBACK_MS);
  window.addEventListener('popstate', start);
}
