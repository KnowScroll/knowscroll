import { makeInvalidateOwnAccountAccess } from '../application/account-lifecycle.js';
import { advanceAccountAccess, fenceAccountPair, fenceOwnAccount } from './account-access.js';
import { makeWithPersonalScope } from '../../../infrastructure/postgres/personal-scope.js';
import { FENCE_ACCOUNT_PAIR, FENCE_OWN_ACCOUNT, INVALIDATE_OWN_ACCOUNT_ACCESS } from '../public.js';
import { CHECK_PERSONAL_OWNER_ACTIVE } from '../public.js';
import { checkPersonalOwnerActive } from './scope-owner.js';
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
import { makePeekSignInLink } from '../application/peek-sign-in-link.js';
import { makeResolveSession, makeSessionValid, makeSignOut, makeSweepSignInRecords } from '../application/sessions.js';
import { operatorAddressMatcher, signInLinkFor } from '../domain/policy.js';
import {
  PEEK_SIGN_IN_LINK,
  READ_ACCOUNT_UNIVERSE,
  READ_UNIVERSE_ACCESS,
  REDEEM_SIGN_IN,
  REQUEST_SIGN_IN,
  RESOLVE_SESSION,
  SESSION_VALID,
  SIGN_OUT,
  SWEEP_SIGN_IN_RECORDS,
  type ReadAccountUniverse,
  type ReadUniverseAccess,
  type SweepSignInRecords,
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
  makeRecordOperatorIssue,
  makeRevokeSessions,
  makeSweep,
  markAddressProved,
  readAccountUniverse,
  readActiveSession,
  readLink,
  readUniverseAccess,
  replaceCommandSessions,
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

/**
 * Whether operator links may be issued or redeemed for an address on this process: only with
 * operator sign-in configured (an allow-listed world, the flag, a pattern; `readApiConfig` and
 * `readOperatorConfig` check those) and only for addresses the pattern matches.
 */
function operatorAddressAllowedBy(pattern: string | undefined): (address: string) => boolean {
  const matches = pattern === undefined ? undefined : operatorAddressMatcher(pattern);
  return matches ?? (() => false);
}

/** Identity's sign-in use cases over one database (framework-free). */
export function identityUseCases(deps: {
  readonly db: Kysely<Database>;
  readonly settings: IdentitySettings;
  readonly lockTimeoutMs: number;
  readonly logEvent: LogEvent;
  readonly mailSender?: MailSender;
}) {
  const withResolvedPersonalScope = makeWithResolvedPersonalScope(deps.db, { lockTimeoutMs: deps.lockTimeoutMs });
  const linkFor = (token: string) => signInLinkFor(deps.settings.publicOrigin, token);
  const operatorAddressAllowed = operatorAddressAllowedBy(deps.settings.operatorSignIn?.pattern);
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
      nativeBinding: deps.settings.nativeSignInBinding,
    }),
    peekSignInLink: makePeekSignInLink({
      readLink: (tokenHash) => readLink(deps.db, tokenHash),
      operatorAddressAllowed,
      secrets: cryptoSecrets,
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
      markAddressProved,
      issueSession,
      replaceCommandSessions,
      operatorAddressAllowed,
      secrets: cryptoSecrets,
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
 * (`readOperatorConfig`: an allow-listed world, `KS_ALLOW_OPERATOR_SIGN_IN=1`, a pattern). Each
 * issue is audited in `ops.operator_sign_ins` with `world` and `operatorSource`.
 */
export function operatorSignInUseCase(deps: {
  readonly db: Kysely<Database>;
  readonly publicOrigin: string;
  readonly lockTimeoutMs: number;
  readonly pattern: string;
  readonly world: string;
  readonly operatorSource: string;
}) {
  return makeIssueOperatorSignIn({
    ...receiptPorts,
    withResolvedPersonalScope: makeWithResolvedPersonalScope(deps.db, { lockTimeoutMs: deps.lockTimeoutMs }),
    operatorAddressAllowed: operatorAddressAllowedBy(deps.pattern),
    lockAddress,
    findAccountByAddress,
    createAccount,
    createOperatorLink,
    recordOperatorIssue: makeRecordOperatorIssue({ world: deps.world, operatorSource: deps.operatorSource }),
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
    pick(PEEK_SIGN_IN_LINK, 'peekSignInLink'),
    pick(REDEEM_SIGN_IN, 'redeemSignIn'),
    pick(RESOLVE_SESSION, 'resolveSession'),
    pick(SESSION_VALID, 'sessionValid'),
    pick(SIGN_OUT, 'signOut'),
  ];
}

/** Identity's scheduled sweep over one database (framework-free; the worker runs it every 15 minutes). */
export function identitySweepUseCase(db: Kysely<Database>): SweepSignInRecords {
  return makeSweepSignInRecords({ sweep: makeSweep(db) });
}

/** Nest wiring of the identity sweep for the worker composition root (`identity.sweep-sign-in-records`). */
export function identitySweepProviders(tokens: { readonly database: symbol }) {
  return [
    {
      provide: SWEEP_SIGN_IN_RECORDS,
      inject: [tokens.database],
      useFactory: (db: Kysely<Database>): SweepSignInRecords => identitySweepUseCase(db),
    },
  ];
}

/** Explicit worker/API scope read; adds no actor impersonation or auth-route behaviour. */
export function identityScopeOwnerProviders() {
  return [{ provide: CHECK_PERSONAL_OWNER_ACTIVE, useValue: checkPersonalOwnerActive }];
}

/** Internal account barriers; no route, erasure executor or provider call is installed. */
export function accountAccessUseCases(deps: { readonly db: Kysely<Database>; readonly lockTimeoutMs: number }) {
  return {
    fenceAccountPair,
    fenceOwnAccount,
    invalidateOwnAccountAccess: makeInvalidateOwnAccountAccess({
      withScope: makeWithPersonalScope(deps.db, { lockTimeoutMs: deps.lockTimeoutMs }),
      fenceOwn: fenceOwnAccount,
      advance: advanceAccountAccess,
    }),
  };
}

/** Composition-root wiring, deliberately separate from public sign-in routes. */
export function accountAccessProviders(tokens: { readonly useCases: symbol }) {
  type Cases = ReturnType<typeof accountAccessUseCases>;
  const pick = <K extends keyof Cases>(provide: symbol, key: K) => ({
    provide,
    inject: [tokens.useCases],
    useFactory: (useCases: Cases): Cases[K] => useCases[key],
  });
  return [
    pick(FENCE_ACCOUNT_PAIR, 'fenceAccountPair'),
    pick(FENCE_OWN_ACCOUNT, 'fenceOwnAccount'),
    pick(INVALIDATE_OWN_ACCOUNT_ACCESS, 'invalidateOwnAccountAccess'),
  ];
}

export { clearExplorationFor, readClearRecoveryCandidates, clearStore } from './clear-providers.js';

export { makeClearExploration } from '../application/clear-exploration.js';
export type { ClearPorts, ClearOperation, ClearStore } from '../application/clear-ports.js';
