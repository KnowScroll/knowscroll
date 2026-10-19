/**
 * In-process request limits for the unauthenticated sign-in routes, keyed by client (`clientKey`:
 * an IPv4 address, or an IPv6 /64). They keep one client from flooding the database; they are
 * taken before anything else, so a client's junk spends only its own budget. The budgets that
 * protect the mail inbox (per address, per recipient domain, world-wide) count links actually
 * issued and live durably in the identity module (review M2), so refused and malformed requests
 * spend none of them.
 */
export interface WindowLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

/** A fixed-window counter per key. `take` answers `undefined` (allowed) or seconds to wait. */
export class WindowLimiter {
  private readonly windows = new Map<string, { readonly startedAt: number; count: number }>();

  constructor(
    private readonly limit: WindowLimit,
    private readonly now: () => number = Date.now,
    /** Bound on remembered keys; the oldest are forgotten first. */
    private readonly maxKeys = 10_000,
  ) {}

  take(key: string): number | undefined {
    const now = this.now();
    const windowMs = this.limit.windowSeconds * 1000;
    let window = this.windows.get(key);
    if (window === undefined || now - window.startedAt >= windowMs) {
      this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (oldest.done !== true) this.windows.delete(oldest.value);
      }
      window = { startedAt: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit.max) return Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1000));
    window.count += 1;
    return undefined;
  }
}

/** The limits of the sign-in routes. */
export const authLimits = {
  /** Sign-in requests by one client. */
  signInPerClient: { max: 10, windowSeconds: 15 * 60 },
  /** Redemption and peek attempts by one client. */
  redeemPerClient: { max: 30, windowSeconds: 15 * 60 },
} as const satisfies Record<string, WindowLimit>;

export interface AuthLimiters {
  readonly signInPerClient: WindowLimiter;
  readonly redeemPerClient: WindowLimiter;
}

export function createAuthLimiters(now: () => number = Date.now): AuthLimiters {
  return {
    signInPerClient: new WindowLimiter(authLimits.signInPerClient, now),
    redeemPerClient: new WindowLimiter(authLimits.redeemPerClient, now),
  };
}
