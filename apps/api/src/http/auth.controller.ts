import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request, Response } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  REDEEM_SIGN_IN,
  REQUEST_SIGN_IN,
  RESOLVE_SESSION,
  SIGN_OUT,
  type RedeemRefusal,
  type RedeemSignIn,
  type RequestSignIn,
  type ResolveSession,
  type SignOut,
} from '@knowscroll/backend/modules/identity';
import { API_CONFIG, AUTH_LIMITERS, LOG_EVENT } from '../tokens.js';
import {
  clearedSessionCookie,
  clientAddress,
  credentialFrom,
  sessionCookie,
  sessionCookieName,
} from './auth-credentials.js';
import type { AuthLimiters } from './auth-rate-limit.js';
import { sessionFor } from './callers.js';
import { problem } from './problems.js';
import { currentRequest } from './request-context.js';

const refusalProblems: Record<RedeemRefusal, ProblemCode> = {
  link_invalid: 'SIGN_IN_LINK_INVALID',
  account_unavailable: 'UNIVERSE_UNAVAILABLE',
  command_key_reused: 'COMMAND_KEY_REUSED',
  outcome_from_newer_release: 'SERVICE_UNAVAILABLE',
};

function responseOf(request: Request): Response {
  const response = request.res;
  if (response === undefined) throw new Error('Express request without its response');
  return response;
}

function requestIdField(): { readonly requestId?: string } {
  const context = currentRequest();
  return context === undefined ? {} : { requestId: context.requestId };
}

/**
 * `/auth/*`: sign-in by email link, sessions and sign-out (D-007, D-022). Thin handlers over the
 * identity use cases; cookies, origin and client-address limits are HTTP concerns and stay here.
 * Every answer is `Cache-Control: no-store` (`noStoreForAuth`).
 */
@Controller()
export class AuthController {
  private readonly cookieName: string;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
    @Inject(AUTH_LIMITERS) private readonly limits: AuthLimiters,
    @Inject(REQUEST_SIGN_IN) private readonly requestSignIn: RequestSignIn,
    @Inject(REDEEM_SIGN_IN) private readonly redeemSignIn: RedeemSignIn,
    @Inject(RESOLVE_SESSION) private readonly resolveSession: ResolveSession,
    @Inject(SIGN_OUT) private readonly signOut: SignOut,
  ) {
    this.cookieName = sessionCookieName(config.identity.secureCookies);
  }

  /** `POST /auth/sign-in`: 202 for every well-formed address; the mail goes out after the answer. */
  @Implement(apiContract.identity.requestSignIn)
  requestSignInRoute(@Req() request: Request) {
    return implement(apiContract.identity.requestSignIn).handler(async ({ input }) => {
      const response = responseOf(request);
      const wait =
        this.limits.signInPerClient.take(clientAddress(request)) ?? this.limits.signInPerProcess.take('process');
      if (wait !== undefined) {
        this.logEvent('identity.sign_in_requested', { ...requestIdField(), outcome: 'client_rate_limited' });
        response.setHeader('retry-after', String(wait));
        throw problem('TOO_MANY_REQUESTS');
      }
      const result = await this.requestSignIn({ email: input.email });
      switch (result.kind) {
        case 'requested':
          // Not awaited: delivery never changes or delays this answer (no address oracle).
          void result.delivery;
          return { status: 'requested' as const };
        case 'refused':
          throw problem('INVALID_REQUEST', { issues: [{ path: ['email'], code: 'invalid_format' }] });
        case 'rate_limited':
          response.setHeader('retry-after', String(result.retryAfterSeconds));
          throw problem('TOO_MANY_REQUESTS');
      }
    });
  }

  /**
   * `POST /auth/redeem`: the link's token for a session. A web redemption must come from this
   * origin (it sets the cookie: no login forgery); a native one gets its bearer token once.
   */
  @Implement(apiContract.identity.redeemSignIn)
  redeemSignInRoute(@Req() request: Request) {
    return implement(apiContract.identity.redeemSignIn).handler(async ({ input }) => {
      const response = responseOf(request);
      const wait = this.limits.redeemPerClient.take(clientAddress(request));
      if (wait !== undefined) {
        response.setHeader('retry-after', String(wait));
        throw problem('TOO_MANY_REQUESTS');
      }
      if (input.client === 'web' && request.headers.origin !== this.config.identity.publicOrigin)
        throw problem('ORIGIN_NOT_ALLOWED');
      const result = await this.redeemSignIn(input);
      if (result.kind === 'refused') {
        this.logEvent('identity.sign_in_refused', { ...requestIdField(), reasonCode: result.reason });
        throw problem(refusalProblems[result.reason]);
      }
      this.logEvent('identity.signed_in', {
        ...requestIdField(),
        outcome: result.replayed ? 'replayed' : result.outcome.accountCreated ? 'created' : 'existing',
        reasonCode: result.origin,
        context: input.client,
      });
      await this.endReplacedSession(request, result.session.id);
      const account = {
        accountId: result.outcome.accountId,
        universeId: result.outcome.universeId,
        privacyEpoch: result.privacyEpoch,
        email: result.address,
      };
      const expiresAt = result.session.expiresAt.toISOString();
      if (input.client === 'web') {
        response.append(
          'set-cookie',
          sessionCookie(result.session.token, result.session.expiresAt, this.config.identity.secureCookies),
        );
        return {
          account,
          accountCreated: result.outcome.accountCreated,
          replayed: result.replayed,
          session: { kind: 'cookie' as const, expiresAt },
        };
      }
      return {
        account,
        accountCreated: result.outcome.accountCreated,
        replayed: result.replayed,
        session: { kind: 'bearer' as const, token: result.session.token, expiresAt },
      };
    });
  }

  /**
   * A redemption on a device that still presents a session (the cookie, or a native bearer token)
   * replaces it: the old session is revoked and its account's sockets dropped, so an account
   * switch leaves no live session behind whose token the device just discarded. Best effort: the
   * new session stands even if this fails (the old one then simply expires).
   */
  private async endReplacedSession(request: Request, newSessionId: string): Promise<void> {
    try {
      const previous = await sessionFor(this.resolveSession, credentialFrom(request.headers, this.cookieName));
      if (previous === undefined || previous.sessionId === newSessionId) return;
      const { revoked } = await this.signOut({
        sessionId: previous.sessionId,
        accountId: previous.accountId,
        everywhere: false,
      });
      this.logEvent('identity.signed_out', { ...requestIdField(), count: revoked, reasonCode: 'replaced' });
    } catch (error) {
      this.logEvent('http.unexpected_error', { ...requestIdField(), method: 'POST', route: '/auth/redeem', error });
    }
  }

  /** `GET /auth/session`: the presented session's account, universe and epoch, read now. */
  @Implement(apiContract.identity.session)
  sessionRoute(@Req() request: Request) {
    return implement(apiContract.identity.session).handler(async () => {
      const session = await sessionFor(this.resolveSession, credentialFrom(request.headers, this.cookieName));
      if (session === undefined) throw problem('UNAUTHENTICATED');
      return {
        account: {
          accountId: session.accountId,
          universeId: session.universeId,
          privacyEpoch: session.privacyEpoch,
          email: session.address,
        },
        client: session.client,
        expiresAt: session.expiresAt.toISOString(),
      };
    });
  }

  /** `POST /auth/sign-out`: ends the session (or all of them) and clears the cookie. */
  @Implement(apiContract.identity.signOut)
  signOutRoute(@Req() request: Request) {
    return implement(apiContract.identity.signOut).handler(async ({ input }) => {
      const response = responseOf(request);
      const credential = credentialFrom(request.headers, this.cookieName);
      if (credential === undefined) throw problem('UNAUTHENTICATED');
      if (credential.kind === 'cookie')
        response.append('set-cookie', clearedSessionCookie(this.config.identity.secureCookies));
      const session = await sessionFor(this.resolveSession, credential);
      const everywhere = input.everywhere === true;
      const { revoked } =
        session === undefined
          ? { revoked: 0 }
          : await this.signOut({ sessionId: session.sessionId, accountId: session.accountId, everywhere });
      this.logEvent('identity.signed_out', {
        ...requestIdField(),
        count: revoked,
        reasonCode: everywhere ? 'everywhere' : 'this_session',
      });
      return { status: 'signed_out' as const, revoked };
    });
  }
}
