/**
 * The one authentication path every reader route uses. The bearer token (or the checked cookie the
 * web-session hook turned into one) is resolved and the universe locked inside a fresh transaction,
 * and the route's work runs in that same transaction, so no route acts on a stale session or epoch
 * (ADR-0009, ADR-0034).
 */

import {
  type AuthScope,
  authenticateAndLock,
  transaction,
  UnauthorizedSession,
} from '@knowscroll/db';
import type pg from 'pg';

/** The route-facing shape of `authenticated`, so route modules can take it as a parameter. */
export type Authenticated = <T>(
  authorization: string | undefined,
  fn: (scope: AuthScope, client: pg.PoolClient) => Promise<T>,
) => Promise<T>;

function bearerToken(authorization: string | undefined): string {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '');
  if (!match) throw new UnauthorizedSession();
  return match[1]!;
}

/** Runs `fn` in an authenticated transaction: a bad or missing credential is `UnauthorizedSession` (401). */
export const authenticated = <T>(
  authorization: string | undefined,
  fn: (scope: AuthScope, client: pg.PoolClient) => Promise<T>,
) =>
  transaction(async (client) => {
    const scope = await authenticateAndLock(client, bearerToken(authorization));
    return fn(scope, client);
  });
