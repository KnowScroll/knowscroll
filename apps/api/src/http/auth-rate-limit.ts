/**
 * In-process request limits for the unauthenticated sign-in routes, keyed by client address
 * (and one process-wide bucket for sign-in mail). They protect the mail inbox and the database
 * from floods; the per-address link limit that a person sees ("try again in a few minutes") is
 * durable and lives in the identity module. One API process per world (D-008), so a per-process
 * count is the world's count; it restarts empty with the process, which only ever loosens it.
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
  /** Sign-in links asked for by one client address. */
  signInPerClient: { max: 10, windowSeconds: 15 * 60 },
  /** Sign-in links asked for across the process (the AgentMail inbox's budget). */
  signInPerProcess: { max: 300, windowSeconds: 15 * 60 },
  /** Redemption attempts by one client address. */
  redeemPerClient: { max: 30, windowSeconds: 15 * 60 },
} as const satisfies Record<string, WindowLimit>;

export interface AuthLimiters {
  readonly signInPerClient: WindowLimiter;
  readonly signInPerProcess: WindowLimiter;
  readonly redeemPerClient: WindowLimiter;
}

export function createAuthLimiters(now: () => number = Date.now): AuthLimiters {
  return {
    signInPerClient: new WindowLimiter(authLimits.signInPerClient, now),
    signInPerProcess: new WindowLimiter(authLimits.signInPerProcess, now),
    redeemPerClient: new WindowLimiter(authLimits.redeemPerClient, now),
  };
}
