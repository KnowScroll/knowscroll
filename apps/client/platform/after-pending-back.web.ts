/** Longest wait for a Back that never reports landing. */
const FALLBACK_MS = 400;

let pending = false;

/**
 * The encounter has just called `history.back()` to remove its transient sheet entry. The Back is
 * asynchronous, so anything that navigates before it lands is popped again. Called synchronously
 * with that `back()`, so a caller that closes a sheet and then navigates sees it as pending.
 */
export function notePendingBack(): void {
  pending = true;
  const landed = () => {
    pending = false;
    window.removeEventListener('popstate', landed);
  };
  window.addEventListener('popstate', landed);
}

/**
 * Runs `run` once a Back the app has just asked the browser for has landed, or at once when none
 * is pending. A sheet that closes and then opens another screen navigates from here. If the Back
 * never reports, `run` starts after `FALLBACK_MS`.
 */
export function afterPendingBack(run: () => void): void {
  if (!pending) {
    run();
    return;
  }
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
