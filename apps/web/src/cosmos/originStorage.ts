/**
 * Per-browser display memory for the opening (ADR-0049 §5): whether this browser has finished or
 * skipped it. A viewer convenience, never evidence: it is not sent anywhere and nothing is inferred
 * from it. (Which recorded changes the sky drew lives in the reader's own purged storage.)
 * Every access is guarded, so a private window or blocked storage simply behaves like a first visit.
 */
const ORIGIN_KEY = 'ks_origin_v1';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the opening may play again next time, which is harmless.
  }
}

export function hasSeenOrigin(): boolean {
  return read(ORIGIN_KEY) === 'seen';
}

export function markOriginSeen(): void {
  write(ORIGIN_KEY, 'seen');
}
