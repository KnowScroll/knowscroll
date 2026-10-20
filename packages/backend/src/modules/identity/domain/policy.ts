/**
 * Identity's fixed limits (D-007, D-022). They are code, not configuration: changing one is a
 * reviewed decision, and the database checks the two lifetimes as well.
 */

/** A sign-in link works once, for at most this long (the migration refuses longer). */
export const SIGN_IN_LINK_TTL_MINUTES = 15;

/** A session lasts at most this long (the migration refuses longer). */
export const SESSION_TTL_DAYS = 30;

export interface LinkLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

/**
 * The mailed-link budgets (review M2). Each counts only links actually issued (after the address
 * was accepted and every narrower budget admitted it), so refused or malformed requests spend
 * nothing:
 * - per address: whoever asks, an address receives at most 3 links per 15 minutes;
 * - per recipient domain: at most 60 per 15 minutes to one domain;
 * - world-wide: at most 300 per 15 minutes, the shared inbox's budget.
 */
export const LINK_LIMITS = {
  address: { max: 3, windowSeconds: 15 * 60 },
  domain: { max: 60, windowSeconds: 15 * 60 },
  world: { max: 300, windowSeconds: 15 * 60 },
} as const satisfies Record<string, LinkLimit>;

export type LinkAdmission =
  { readonly kind: 'admit' } | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

/**
 * Whether another link fits a budget, given the ages (seconds, database clock) of the newest
 * links counted by it (at least the `limit.max` newest, if there are that many). When it does not,
 * `retryAfterSeconds` is when enough of them will have left the window. Pure.
 */
export function admitLink(recentAgesSeconds: readonly number[], limit: LinkLimit): LinkAdmission {
  const inWindow = recentAgesSeconds.filter((age) => age >= 0 && age < limit.windowSeconds).sort((a, b) => b - a);
  if (inWindow.length < limit.max) return { kind: 'admit' };
  // The oldest links leave first; once `inWindow.length - limit.max + 1` of them have left, one fits.
  const blocking = inWindow[inWindow.length - limit.max] ?? 0;
  return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(limit.windowSeconds - blocking)) };
}

/**
 * The worlds where operator sign-in may ever run (review m3): an allow-list, so a production world
 * named anything at all is refused. Live is never among them.
 */
export const OPERATOR_WORLDS: readonly string[] = ['dev', 'stage', 'ci', 'local'];

/**
 * The world's disposable-address pattern for operator sign-in (`KS_OPERATOR_SIGN_IN_PATTERN`,
 * review m2), as a matcher, or `undefined` when the pattern is not acceptable. A pattern is one
 * address whose local part may contain `*` (any run of local-part characters) and whose domain is
 * literal, for example `*@test.knowscroll.space` or `knowscroll+*@agentmail.to`. Operator links
 * are issued and redeemed only for addresses it matches. Pure.
 */
export function operatorAddressMatcher(pattern: string): ((address: string) => boolean) | undefined {
  const at = pattern.indexOf('@');
  if (at <= 0 || pattern.includes('@', at + 1) || pattern !== pattern.toLowerCase()) return undefined;
  const local = pattern.slice(0, at);
  const domain = pattern.slice(at + 1);
  const localShape = /^[a-z0-9.+_-]*\*?[a-z0-9.+_-]*$/;
  if (!localShape.test(local)) return undefined;
  if (!literalDomain.test(domain)) return undefined;
  const expression = new RegExp(
    `^${local.split('*').map(escapeForPattern).join(anyLocalRun)}@${escapeForPattern(domain)}$`,
  );
  return (address) => expression.test(address);
}

const literalDomain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const anyLocalRun = "[a-z0-9.!#$%&'*+/=?^_`{|}~-]*";

function escapeForPattern(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The client route a sign-in link opens: `<public origin>/redeem#token=<token>`. The token rides
 * in the fragment, so it never reaches a server log, a proxy or a `Referer`; the page shows the
 * masked address and asks the person to confirm before it POSTs the token to `/auth/redeem` (a
 * prefetched or scanned link signs nobody in). Must match `apps/client/app/(auth)/redeem.tsx`.
 */
export function signInLinkFor(publicOrigin: string, token: string): string {
  return `${publicOrigin}/redeem#token=${token}`;
}
