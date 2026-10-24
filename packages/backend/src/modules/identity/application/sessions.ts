import type {
  ActiveSession,
  EndOtherSessions,
  EndSession,
  ListSessions,
  ResolveSession,
  SessionValid,
  SignOut,
  SweepSignInRecords,
} from '../public.js';
import type { SessionPorts, SweepPorts } from './ports.js';

/**
 * `resolveSession`: the authority behind a presented session token, re-read on every request:
 * the session must be unrevoked and unexpired and its account and universe active; the universe
 * and its privacy epoch are the current ones, never values remembered from sign-in. Read-only.
 */
export function makeResolveSession(ports: SessionPorts): ResolveSession {
  return async function resolveSession(token: string): Promise<ActiveSession | undefined> {
    return ports.readActiveSession(ports.secrets.hashToken(token));
  };
}

/**
 * `sessionValid`: whether a session that authenticated a long-lived socket still holds (not
 * signed out, revoked or expired; account and universe active). Read-only.
 */
export function makeSessionValid(ports: SessionPorts): SessionValid {
  return async function sessionValid(session: {
    readonly sessionId: string;
    readonly accountId: string;
  }): Promise<boolean> {
    return ports.sessionStillValid(session);
  };
}

/**
 * `signOut`: end this session, or every session of the account (POST /auth/sign-out), or the
 * session a device replaced by signing into another account.
 *
 * Steps (one transaction): set `revoked_at` on the session(s) → `revokeAccountSockets` in the same
 * transaction, so every API process drops the account's sockets once the revocation commits (a
 * lost notice is covered by the gateway's session rechecks). Returns how many sessions ended;
 * signing out a session that already ended is a no-op that still answers success.
 */
export function makeSignOut(ports: SessionPorts): SignOut {
  return async function signOut(request): Promise<{ readonly revoked: number }> {
    const reason = request.reason ?? (request.everywhere ? 'signed_out_everywhere' : 'signed_out');
    return {
      revoked: await ports.revokeSessions({
        sessionId: request.sessionId,
        accountId: request.accountId,
        target: request.everywhere ? 'every_session' : 'session',
        reason,
      }),
    };
  };
}

/**
 * `sweepSignInRecords`: the scheduled sweep (`identity.sweep-sign-in-records`, every 15 minutes,
 * worker; review m12). Deletes sign-in links a day after they expired (an unredeemed link holds an
 * address that may have no account) and sessions 30 days after they ended, in bounded batches
 * that skip rows other transactions hold, so it never waits on or deadlocks with sign-in.
 */
export function makeSweepSignInRecords(ports: SweepPorts): SweepSignInRecords {
  return () => ports.sweep();
}

/**
 * `listSessions`: the account's live sessions for P01, the presented one marked current. Read-only.
 * Devices that signed in before labels existed show the plain label of their client.
 */
export function makeListSessions(ports: SessionPorts): ListSessions {
  return async function listSessions(caller) {
    const sessions = await ports.listLiveSessions(caller.accountId);
    return sessions.map((session) => ({
      id: session.id,
      client: session.client,
      deviceLabel: session.deviceLabel ?? (session.client === 'native' ? 'KnowScroll app' : 'Web browser'),
      signedInAt: session.signedInAt,
      lastUsedAt: session.lastUsedAt ?? session.signedInAt,
      current: session.id === caller.sessionId,
    }));
  };
}

/**
 * `endSession`: signs one *other* session of the account out (P01 "Sign out" beside a device).
 * The presented session is refused: leaving this device is `signOut`, which also clears the
 * cookie. An id that is unknown, already ended or another person's gets the same `not_found`.
 */
export function makeEndSession(ports: SessionPorts): EndSession {
  return async function endSession(request) {
    if (request.sessionId === request.currentSessionId) return { kind: 'current_session' };
    const revoked = await ports.revokeSessions({
      sessionId: request.sessionId,
      accountId: request.accountId,
      target: 'session',
      reason: 'signed_out',
    });
    return revoked === 0 ? { kind: 'not_found' } : { kind: 'ended' };
  };
}

/** `endOtherSessions`: signs out every session of the account except the presented one. */
export function makeEndOtherSessions(ports: SessionPorts): EndOtherSessions {
  return async function endOtherSessions(request) {
    return {
      revoked: await ports.revokeSessions({
        sessionId: request.currentSessionId,
        accountId: request.accountId,
        target: 'other_sessions',
        reason: 'signed_out_everywhere',
      }),
    };
  };
}
