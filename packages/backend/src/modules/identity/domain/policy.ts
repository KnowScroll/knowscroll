/**
 * Identity's fixed limits (D-007, D-022). They are code, not configuration: changing one is a
 * reviewed decision, and the database checks the two lifetimes as well.
 */

/** A sign-in link works once, for at most this long (the migration refuses longer). */
export const SIGN_IN_LINK_TTL_MINUTES = 15;

/** A session lasts at most this long (the migration refuses longer). */
export const SESSION_TTL_DAYS = 30;

/** Sign-in links one address may receive per window, whoever asks. */
export const ADDRESS_LINK_LIMIT = { max: 3, windowSeconds: 15 * 60 } as const;

export interface LinkLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

export type LinkAdmission =
  { readonly kind: 'admit' } | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

/**
 * Whether another link may be created for an address, given the ages (seconds, database clock) of
 * the links it received inside the window. When it may not, `retryAfterSeconds` is when enough of
 * them will have left the window. Pure.
 */
export function admitLink(recentAgesSeconds: readonly number[], limit: LinkLimit): LinkAdmission {
  const inWindow = recentAgesSeconds.filter((age) => age >= 0 && age < limit.windowSeconds).sort((a, b) => b - a);
  if (inWindow.length < limit.max) return { kind: 'admit' };
  // The oldest links leave first; once `inWindow.length - limit.max + 1` of them have left, one fits.
  const blocking = inWindow[inWindow.length - limit.max] ?? 0;
  return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(limit.windowSeconds - blocking)) };
}

/**
 * The client route a sign-in link opens: `<public origin>/redeem#token=<token>`. The token rides
 * in the fragment, so it never reaches a server log, a proxy or a `Referer`; the page asks the
 * person to confirm, then POSTs it to `/auth/redeem` (a prefetched or scanned link signs nobody
 * in). Must match `apps/client/app/(auth)/redeem.tsx`.
 */
export function signInLinkFor(publicOrigin: string, token: string): string {
  return `${publicOrigin}/redeem#token=${token}`;
}
