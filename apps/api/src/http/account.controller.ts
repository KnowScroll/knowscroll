import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request, Response } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  CLAIM_FIRST_OPEN,
  END_OTHER_SESSIONS,
  END_SESSION,
  LIST_SESSIONS,
  type ClaimFirstOpen,
  type DataExportSummary,
  type EndOtherSessions,
  type EndSession,
  type ListSessions,
} from '@knowscroll/backend/modules/identity';
import {
  DATA_EXPORT,
  DELETE_ACCOUNT,
  type DataExportUseCases,
  type DeleteAccountUseCases,
} from '../modules/account.js';
import { API_CONFIG, AUTH_LIMITERS, LOG_EVENT } from '../tokens.js';
import { clearedSessionCookie, clientAddress } from './auth-credentials.js';
import type { AuthLimiters } from './auth-rate-limit.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const exportRefusals: Record<'id_in_use' | 'not_found' | 'not_ready' | 'scope_refused', ProblemCode> = {
  id_in_use: 'COMMAND_KEY_REUSED',
  not_found: 'NOT_FOUND',
  not_ready: 'CONFLICT',
  scope_refused: 'UNIVERSE_UNAVAILABLE',
};

const deletionRefusals = {
  receipt_in_use: 'COMMAND_KEY_REUSED',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  unavailable: 'UNIVERSE_UNAVAILABLE',
} as const satisfies Record<string, ProblemCode>;

function wireExport(summary: DataExportSummary) {
  return {
    id: summary.id,
    state: summary.state,
    requestedAt: summary.requestedAt.toISOString(),
    expiresAt: summary.expiresAt?.toISOString() ?? null,
  };
}

function responseOf(request: Request): Response {
  const response = request.res;
  if (response === undefined) throw new Error('Express request without its response');
  return response;
}

/**
 * Account (#246, D-043): the caller's sessions, personal data export and account deletion, plus the
 * two deletion-receipt routes that need no session (deletion ends every session, and the device
 * must still be able to ask how it is going). Thin handlers over the identity use cases.
 */
@Controller()
export class AccountController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
    @Inject(AUTH_LIMITERS) private readonly limits: AuthLimiters,
    @Inject(LIST_SESSIONS) private readonly listSessions: ListSessions,
    @Inject(END_SESSION) private readonly endSession: EndSession,
    @Inject(END_OTHER_SESSIONS) private readonly endOtherSessions: EndOtherSessions,
    @Inject(CLAIM_FIRST_OPEN) private readonly claimFirstOpen: ClaimFirstOpen,
    @Inject(DELETE_ACCOUNT) private readonly deletion: DeleteAccountUseCases,
    @Inject(DATA_EXPORT) private readonly exports: DataExportUseCases,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.sessions)
  sessionsRoute(@Req() request: Request) {
    return implement(apiContract.account.sessions).handler(async () => {
      const caller = admittedCaller(request);
      const sessions = await this.listSessions({ accountId: caller.accountId, sessionId: caller.sessionId });
      return {
        sessions: sessions.map((session) => ({
          id: session.id,
          client: session.client,
          deviceLabel: session.deviceLabel,
          signedInAt: session.signedInAt.toISOString(),
          lastUsedAt: session.lastUsedAt.toISOString(),
          current: session.current,
        })),
      };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.endSession)
  endSessionRoute(@Req() request: Request) {
    return implement(apiContract.account.endSession).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.endSession({
        accountId: caller.accountId,
        currentSessionId: caller.sessionId,
        sessionId: input.sessionId,
      });
      if (result.kind === 'current_session') throw problem('CONFLICT');
      if (result.kind === 'not_found') throw problem('NOT_FOUND');
      this.logEvent('identity.signed_out', { count: 1, reasonCode: 'other_session' });
      return { status: 'ended' as const };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.endOtherSessions)
  endOtherSessionsRoute(@Req() request: Request) {
    return implement(apiContract.account.endOtherSessions).handler(async () => {
      const caller = admittedCaller(request);
      const { revoked } = await this.endOtherSessions({
        accountId: caller.accountId,
        currentSessionId: caller.sessionId,
      });
      this.logEvent('identity.signed_out', { count: revoked, reasonCode: 'other_sessions' });
      return { revoked };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.claimFirstOpen)
  claimFirstOpenRoute(@Req() request: Request) {
    return implement(apiContract.account.claimFirstOpen).handler(async () =>
      this.claimFirstOpen({ accountId: admittedCaller(request).accountId }),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.exports.request)
  requestExportRoute(@Req() request: Request) {
    return implement(apiContract.account.exports.request).handler(async ({ input }) => {
      const result = await this.exports.request(authorityOf(admittedCaller(request)), { exportId: input.exportId });
      if (result.kind === 'refused') throw problem(exportRefusals[result.reason]);
      return { export: wireExport(result.export) };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.exports.list)
  listExportsRoute(@Req() request: Request) {
    return implement(apiContract.account.exports.list).handler(async () => {
      const result = await this.exports.list(authorityOf(admittedCaller(request)));
      if (result.kind === 'refused') throw problem(exportRefusals[result.reason]);
      return { exports: result.exports.map(wireExport) };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.exports.link)
  exportLinkRoute(@Req() request: Request) {
    return implement(apiContract.account.exports.link).handler(async ({ input }) => {
      const result = await this.exports.mintLink(authorityOf(admittedCaller(request)), { exportId: input.exportId });
      if (result.kind === 'refused') throw problem(exportRefusals[result.reason]);
      return { path: `/auth/exports/${result.token}`, expiresAt: result.expiresAt.toISOString() };
    });
  }

  /**
   * Fences the account and queues its erasure; the session ends with this answer, so the web
   * cookie is cleared here. A request made for an older epoch is refused before anything changes.
   */
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.account.delete)
  deleteRoute(@Req() request: Request) {
    return implement(apiContract.account.delete).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      if (input.expectedPrivacyEpoch !== caller.privacyEpoch) throw problem('PRIVACY_EPOCH_CHANGED');
      const result = await this.deletion.request(authorityOf(caller), { receiptId: input.receiptId });
      this.logEvent('identity.account_deletion_requested', {
        outcome: result.kind === 'accepted' ? 'accepted' : result.reason,
      });
      if (result.kind === 'refused') throw problem(deletionRefusals[result.reason]);
      if (caller.credential === 'cookie')
        responseOf(request).append('set-cookie', clearedSessionCookie(this.config.identity.secureCookies));
      return { receiptId: result.receiptId, requestedAt: result.requestedAt.toISOString() };
    });
  }

  @Implement(apiContract.account.deletionStatus)
  deletionStatusRoute(@Req() request: Request) {
    return implement(apiContract.account.deletionStatus).handler(async ({ input }) => {
      this.takeClientBudget(request);
      const state = await this.deletion.readReceipt(input.receiptId);
      if (state === undefined) throw problem('NOT_FOUND');
      return { state };
    });
  }

  @Implement(apiContract.account.retryDeletion)
  retryDeletionRoute(@Req() request: Request) {
    return implement(apiContract.account.retryDeletion).handler(async ({ input }) => {
      this.takeClientBudget(request);
      const result = await this.deletion.retry(input.receiptId);
      if (result.kind === 'not_found') throw problem('NOT_FOUND');
      return { state: result.kind === 'completed' ? ('completed' as const) : ('in_progress' as const) };
    });
  }

  /** The receipt routes take no session, so they have their own per-client brake. */
  private takeClientBudget(request: Request): void {
    const wait = this.limits.receiptPerClient.take(clientAddress(request));
    if (wait === undefined) return;
    responseOf(request).setHeader('retry-after', String(wait));
    throw problem('TOO_MANY_REQUESTS');
  }
}
