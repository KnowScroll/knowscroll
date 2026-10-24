/**
 * Runs `run` once a Back the app has just asked the browser for has landed. On native there is no
 * browser history, so it runs at once. See `after-pending-back.web.ts`.
 */
export function afterPendingBack(run: () => void): void {
  run();
}

/** The encounter has just asked the browser to go Back. Nothing to track on native. */
export function notePendingBack(): void {}
