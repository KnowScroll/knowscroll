/**
 * In-process request limits for the unauthenticated sign-in routes, keyed by client (`clientKey`:
 * an IPv4 address, or an IPv6 /64). A first-line flood brake for the database, taken before
 * anything else so a client's junk spends only its own budget, and **not** a source of truth:
 * the counts live in this process's memory, start empty after a restart, and when more than
 * 10,000 clients are being counted the one counted longest ago is forgotten, so a client spread
 * over more addresses than that can recycle its budget (re-review nit). What protects the mail
 * inbox and the people it mails are the durable budgets in the identity module (per address,
 * per recipient domain, world-wide; counting only links actually issued: review M2).
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
