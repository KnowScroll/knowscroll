import { SESSION_TOKEN_PATTERN } from '@knowscroll/contracts';
import type { AuthAdapter } from '@knowscroll/backend/infrastructure/config';
import type {
  ActiveSession,
  PersonalAuthority,
  ReadAccountUniverse,
  ResolveSession,
  SessionValid,
} from '@knowscroll/backend/modules/identity';
import { credentialFrom, type Credential, type CredentialHeaders } from './auth-credentials.js';

/** The authenticated person behind a request or socket, as a claim to be rechecked under lock. */
export interface Caller {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  /** Opaque identity of the session the caller authenticated with (its `identity.sessions` row). */
  readonly sessionId: string;
  /** How it authenticated: a web cookie (origin-checked) or a bearer token. */
  readonly credential: Credential['kind'];
}

/**
 * The AuthenticatedCaller port. In production it is the session adapter below: the identity
 * module's sessions (D-007, D-018), re-read on every request. CI may run the test-only adapter.
 */
export interface AuthenticatedCallers {
  /**
   * Resolves the credential in these headers (`Authorization: Bearer …` wins over the session
   * cookie) to a caller, or nothing. Authority is the session's account, that account's
   * universe and its current privacy epoch, read now.
   */
  resolve(headers: CredentialHeaders): Promise<Caller | undefined>;
  /**
   * Whether the session `caller` authenticated with is still valid now (not signed out, revoked
   * or expired). Sockets outlive the request that authenticated them, so the gateway asks again
   * on every subscribe and whenever it re-authorises a socket for a relayed hint.
   */
  sessionValid(caller: Caller): Promise<boolean>;
}

/** The claim a caller makes on its personal universe; `withPersonalScope` rechecks it. */
export function authorityOf(caller: Caller): PersonalAuthority {
  return {
    universeId: caller.universeId,
    privacyEpoch: caller.privacyEpoch,
    actor: { kind: 'account', accountId: caller.accountId },
  };
}

/**
 * The session a credential presents, when it is a well-formed session token of the matching
 * kind: a web session only as the cookie, a native one only as a bearer token. A web session's
 * token is therefore never accepted without the cookie's origin checks.
 */
export async function sessionFor(
  resolveSession: ResolveSession,
  credential: Credential | undefined,
): Promise<ActiveSession | undefined> {
  if (credential === undefined || !SESSION_TOKEN_PATTERN.test(credential.token)) return undefined;
  const session = await resolveSession(credential.token);
  if (session === undefined) return undefined;
  return (session.client === 'web') === (credential.kind === 'cookie') ? session : undefined;
}

/**
 * The production adapter: identity's sessions. `resolve` reads the session, its account and that
 * account's universe and current epoch on every call (unrevoked, unexpired, both active);
 * `sessionValid` rereads the session row. Revoked or expired sessions resolve to nothing (401).
 */
export function sessionCallers(deps: {
  readonly resolveSession: ResolveSession;
  readonly sessionValid: SessionValid;
  readonly cookieName: string;
}): AuthenticatedCallers {
  return {
    async resolve(headers) {
      const credential = credentialFrom(headers, deps.cookieName);
      const session = await sessionFor(deps.resolveSession, credential);
      if (session === undefined || credential === undefined) return undefined;
      return {
        accountId: session.accountId,
        universeId: session.universeId,
        privacyEpoch: session.privacyEpoch,
        sessionId: session.sessionId,
        credential: credential.kind,
      };
    },
    sessionValid: (caller) => deps.sessionValid({ sessionId: caller.sessionId, accountId: caller.accountId }),
  };
}

const testBearerPattern = /^Bearer test\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * TEST ONLY (CI fixture): trusts `Authorization: Bearer test.<accountId>` and reads the account's
 * universe. Its "sessions" have no record and are always valid. Configuration refuses it unless
 * `NODE_ENV=test` in a `ci` or `local` world, and `selectCallers` refuses it again, so a deployed
 * world can never start with it.
 */
function testBearerCallers(readAccountUniverse: ReadAccountUniverse): AuthenticatedCallers {
  return {
    async resolve(headers) {
      const match = headers.authorization === undefined ? null : testBearerPattern.exec(headers.authorization);
      if (match?.[1] === undefined) return undefined;
      const account = await readAccountUniverse(match[1]);
      if (account === undefined || account.accountStatus !== 'active' || account.universeStatus !== 'active')
        return undefined;
      return {
        accountId: account.accountId,
        universeId: account.universeId,
        privacyEpoch: account.privacyEpoch,
        sessionId: `test:${account.accountId}`,
        credential: 'bearer',
      };
    },
    sessionValid: () => Promise.resolve(true),
  };
}

/** Chooses the caller adapter for this process (composition root only). */
export function selectCallers(
  adapter: AuthAdapter,
  release: { readonly nodeEnv: string; readonly world: string },
  deps: {
    readonly readAccountUniverse: ReadAccountUniverse;
    readonly resolveSession: ResolveSession;
    readonly sessionValid: SessionValid;
    readonly cookieName: string;
  },
): AuthenticatedCallers {
  switch (adapter) {
    case 'session':
      return sessionCallers(deps);
    case 'test-bearer':
      if (release.nodeEnv !== 'test' || !['ci', 'local'].includes(release.world)) {
        throw new Error('The test-bearer caller adapter is refused outside NODE_ENV=test in a ci or local world');
      }
      return testBearerCallers(deps.readAccountUniverse);
  }
}
