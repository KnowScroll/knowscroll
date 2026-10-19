import type { Kysely } from 'kysely';
import type { IdentitySettings } from '../../../infrastructure/config/index.js';
import type { LogEvent } from '../../../infrastructure/observability/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithResolvedPersonalScope } from '../../../infrastructure/postgres/personal-scope.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
} from '../../../infrastructure/receipts/index.js';
import { makeIssueOperatorSignIn } from '../application/issue-operator-sign-in.js';
import type { MailSender, ReceiptPorts, SessionPorts } from '../application/ports.js';
import { makeRedeemSignIn } from '../application/redeem-sign-in.js';
import { makeRequestSignIn } from '../application/request-sign-in.js';
import { makeResolveSession, makeSessionValid, makeSignOut } from '../application/sessions.js';
import { signInLinkFor } from '../domain/policy.js';
import {
  READ_ACCOUNT_UNIVERSE,
  READ_UNIVERSE_ACCESS,
  REDEEM_SIGN_IN,
  REQUEST_SIGN_IN,
  RESOLVE_SESSION,
  SESSION_VALID,
  SIGN_OUT,
  type ReadAccountUniverse,
  type ReadUniverseAccess,
} from '../public.js';
import { agentMailSender } from './agentmail-sender.js';
import { fixtureMailSender } from './fixture-mail-sender.js';
import {
  consumeLink,
  createAccount,
  createOperatorLink,
  findAccountByAddress,
  findAccountById,
  issueSession,
  lockAddress,
  lockLink,
  makeCreateEmailLink,
  makeRevokeSessions,
  readAccountUniverse,
  readActiveSession,
  readUniverseAccess,
  sessionStillValid,
} from './postgres-store.js';
import { cryptoSecrets } from './secrets.js';

/** Reusable outer wiring (blueprint §22): identity's read ports. Composition roots only. */
export function identityProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: READ_ACCOUNT_UNIVERSE,
      inject: [tokens.database],
      useFactory:
        (db: Kysely<Database>): ReadAccountUniverse =>
        (accountId) =>
          readAccountUniverse(db, accountId),
    },
    {
      provide: READ_UNIVERSE_ACCESS,
      inject: [tokens.database],
      useFactory:
        (db: Kysely<Database>): ReadUniverseAccess =>
        (accountId, universeId) =>
          readUniverseAccess(db, accountId, universeId),
    },
  ];
}

const receiptPorts: ReceiptPorts = {
  hashRequest: requestHash,
  findReceipt: findPersonalReceipt,
  insertReceipt: insertPersonalReceipt,
  completeReceipt: completePersonalReceipt,
};

/**
 * The mail sender the settings name: AgentMail (production accepts nothing else), or the CI
 * fixture sender, which configuration refuses outside `NODE_ENV=test` in a `ci`/`local` world.
 */
export function mailSenderFor(settings: IdentitySettings['mail']): MailSender {
  switch (settings.sender) {
    case 'agentmail':
      return agentMailSender({
        apiKey: settings.apiKey,
        inboxId: settings.inboxId,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
      });
    case 'fixture':
      return fixtureMailSender({ outboxFile: settings.outboxFile });
  }
}

/** Identity's sign-in use cases over one database (framework-free; also used by the operator command). */
export function identityUseCases(deps: {
  readonly db: Kysely<Database>;
  readonly settings: IdentitySettings;
  readonly lockTimeoutMs: number;
  readonly logEvent: LogEvent;
  readonly mailSender?: MailSender;
}) {
  const withResolvedPersonalScope = makeWithResolvedPersonalScope(deps.db, { lockTimeoutMs: deps.lockTimeoutMs });
  const linkFor = (token: string) => signInLinkFor(deps.settings.publicOrigin, token);
  const sessionPorts: SessionPorts = {
    readActiveSession: (tokenHash) => readActiveSession(deps.db, tokenHash),
    sessionStillValid: (session) => sessionStillValid(deps.db, session),
    revokeSessions: makeRevokeSessions(deps.db),
    secrets: cryptoSecrets,
  };
  return {
    requestSignIn: makeRequestSignIn({
      createEmailLink: makeCreateEmailLink(deps.db, { lockTimeoutMs: deps.lockTimeoutMs }),
      sendMail: deps.mailSender ?? mailSenderFor(deps.settings.mail),
      linkFor,
      secrets: cryptoSecrets,
      logEvent: deps.logEvent,
      now: () => performance.now(),
    }),
    redeemSignIn: makeRedeemSignIn({
      ...receiptPorts,
      withResolvedPersonalScope,
      lockAddress,
      lockLink,
      findAccountByAddress,
      findAccountById,
      createAccount,
      consumeLink,
      issueSession,
      secrets: cryptoSecrets,
      operatorSignInEnabled: deps.settings.operatorSignIn,
    }),
    resolveSession: makeResolveSession(sessionPorts),
    sessionValid: makeSessionValid(sessionPorts),
    signOut: makeSignOut(sessionPorts),
  };
}

export type IdentityUseCases = ReturnType<typeof identityUseCases>;

/**
 * The operator command's use case alone (D-007: `dist/operator.js issue-sign-in` on dev/stage).
 * It sends no mail and redeems nothing; whether it may run at all is the caller's check
 * (`readOperatorConfig` refuses live and a missing `KS_ALLOW_OPERATOR_SIGN_IN=1`).
 */
export function operatorSignInUseCase(deps: {
  readonly db: Kysely<Database>;
  readonly publicOrigin: string;
  readonly lockTimeoutMs: number;
}) {
  return makeIssueOperatorSignIn({
    ...receiptPorts,
    withResolvedPersonalScope: makeWithResolvedPersonalScope(deps.db, { lockTimeoutMs: deps.lockTimeoutMs }),
    lockAddress,
    findAccountByAddress,
    createAccount,
    createOperatorLink,
    linkFor: (token) => signInLinkFor(deps.publicOrigin, token),
    secrets: cryptoSecrets,
  });
}

/**
 * Nest wiring of the sign-in use cases for the API composition root. `tokens.useCases` names a
 * provider holding {@link identityUseCases}' result, built once by the root.
 */
export function signInProviders(tokens: { readonly useCases: symbol }) {
  const pick = <K extends keyof IdentityUseCases>(provide: symbol, key: K) => ({
    provide,
    inject: [tokens.useCases],
    useFactory: (useCases: IdentityUseCases): IdentityUseCases[K] => useCases[key],
  });
  return [
    pick(REQUEST_SIGN_IN, 'requestSignIn'),
    pick(REDEEM_SIGN_IN, 'redeemSignIn'),
    pick(RESOLVE_SESSION, 'resolveSession'),
    pick(SESSION_VALID, 'sessionValid'),
    pick(SIGN_OUT, 'signOut'),
  ];
}
