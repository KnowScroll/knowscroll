/**
 * Identity's framework-free public surface: who may act on a personal universe, the capabilities
 * a protected transaction carries, and the read ports other code uses to resolve callers. The
 * lock protocol itself is implemented by `infrastructure/postgres` (`withPersonalScope`,
 * `enterSharedRoot`); the read ports are implemented by `adapters/` and bound by the apps'
 * composition roots through `adapters/nest-providers.ts`.
 */

/** Who is acting. Workers act as `system` on behalf of a universe; they never borrow a caller. */
export type Actor =
  { readonly kind: 'account'; readonly accountId: string } | { readonly kind: 'system'; readonly purpose: string };

/**
 * The authority a personal mutation claims. `withPersonalScope` rechecks every field against the
 * locked universe row after waiting for the lock; nothing here is trusted on its own.
 */
export interface PersonalAuthority {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly actor: Actor;
}

declare const personalScopeBrand: unique symbol;
declare const sharedScopeBrand: unique symbol;

/**
 * The capability of one open, locked personal transaction. Only `withPersonalScope` creates it,
 * and it stops working when that transaction ends. Personal-write ports require it. The brand is
 * a compile-time aid; the row lock and the runtime rechecks establish authority. Its `authority`
 * is a frozen copy: nothing can change which universe a scope writes to.
 */
export interface PersonalScopeTx {
  readonly [personalScopeBrand]: true;
  readonly authority: PersonalAuthority;
  /** The universe revision observed under the lock, before this transaction's changes. */
  readonly revisionAtEntry: number;
}

/**
 * The capability of one shared root (conversation, room, exploration) locked *after* the actor's
 * personal root, inside the same transaction (blueprint §19 lock order: personal root → this
 * universe's rows → at most one shared root → its subordinate rows). Only `enterSharedRoot` creates
 * it, at most once per personal scope.
 */
export interface SharedScopeTx {
  readonly [sharedScopeBrand]: true;
  readonly personal: PersonalScopeTx;
  readonly root: { readonly kind: string; readonly id: string };
}

/** Why a personal scope could not be entered. */
export type ScopeRefusal =
  | { readonly kind: 'universe_missing' }
  | { readonly kind: 'universe_suspended' }
  | { readonly kind: 'account_mismatch' }
  | { readonly kind: 'epoch_changed'; readonly currentEpoch: number };

export type ScopeOutcome<T> =
  { readonly kind: 'entered'; readonly value: T } | { readonly kind: 'refused'; readonly refusal: ScopeRefusal };

/**
 * Runs `work` inside one transaction holding the personal root lock (`FOR NO KEY UPDATE` on
 * `identity.universes`), after rechecking status, epoch and actor. Lock order: personal root
 * first, then this universe's rows, then at most one shared root (`enterSharedRoot`); never
 * another person's root inside `work`.
 */
export type WithPersonalScope = <T>(
  authority: PersonalAuthority,
  work: (scope: PersonalScopeTx) => Promise<T>,
) => Promise<ScopeOutcome<T>>;

declare const rootResolutionBrand: unique symbol;

/**
 * The capability of a transaction that has not locked a personal root yet: the first phase of
 * `WithResolvedPersonalScope`. Only identity's adapters use it, to take the locks that come
 * before the personal root in identity's lock order (address, then sign-in link) and to create
 * an account with its universe root. Unusable once its transaction ended.
 */
export interface RootResolutionTx {
  readonly [rootResolutionBrand]: true;
}

/** What the first phase decided: enter the personal scope of `authority`, or stop with `result`. */
export type RootResolution<C, R> =
  | { readonly kind: 'enter'; readonly authority: PersonalAuthority; readonly context: C }
  | { readonly kind: 'stop'; readonly result: R };

export type ResolvedScopeOutcome<T, R> =
  | { readonly kind: 'entered'; readonly value: T }
  | { readonly kind: 'stopped'; readonly result: R }
  | { readonly kind: 'refused'; readonly refusal: ScopeRefusal };

/**
 * What the second phase decided: commit its value, or roll everything back (the resolution's
 * writes too) and answer `stopped` with `result`. A refusal inside the scope therefore writes
 * nothing: a refused redemption never consumes its link (review m1).
 */
export type ScopeWork<T, R> =
  { readonly kind: 'commit'; readonly value: T } | { readonly kind: 'rollback'; readonly result: R };

/**
 * `withPersonalScope` for commands that find or create the personal root themselves (sign-in:
 * the universe is known only after the sign-in link is read, and created on first sign-in).
 * Runs in one transaction: `resolve` (with the bounded lock timeout already set) takes identity's
 * earlier locks, may create the account and its universe, and names the universe to enter; the
 * root is then locked and rechecked exactly as `withPersonalScope` does, and `work` runs with the
 * scope. A `stop`, a refusal, a `rollback` from `work` or an exception rolls back everything
 * `resolve` wrote; nothing commits unless `work` answers `commit`.
 */
export type WithResolvedPersonalScope = <C, R, T>(
  resolve: (tx: RootResolutionTx) => Promise<RootResolution<C, R>>,
  work: (scope: PersonalScopeTx, context: C) => Promise<ScopeWork<T, R>>,
) => Promise<ResolvedScopeOutcome<T, R>>;

/**
 * Port: does `authority` still hold right now? The same checks as `withPersonalScope`, read
 * without a lock and without writing (implemented by `infrastructure/postgres`). For decisions
 * that change nothing; whatever writes later rechecks under the lock.
 */
export type AuthorityHolds = (authority: PersonalAuthority) => Promise<boolean>;

/** An account with its personal universe, as authentication resolves a caller. */
export interface AccountUniverse {
  readonly accountId: string;
  readonly accountStatus: string;
  readonly universeId: string;
  readonly universeStatus: string;
  readonly privacyEpoch: number;
}

/**
 * Port: read an account and its universe (no lock). The result is a claim that
 * `withPersonalScope` rechecks under the lock. `undefined` when either is missing.
 */
export type ReadAccountUniverse = (accountId: string) => Promise<AccountUniverse | undefined>;

/** Current access of an account to one of its universes, read without a lock. */
export interface UniverseAccess {
  readonly revision: number;
  readonly privacyEpoch: number;
  /** Universe and account both active. */
  readonly active: boolean;
}

/** Port: does `accountId` own `universeId`, and is it usable? `undefined` when not owned. */
export type ReadUniverseAccess = (accountId: string, universeId: string) => Promise<UniverseAccess | undefined>;

/** Injection tokens of identity's read ports (bound by the composition roots). */
export const READ_ACCOUNT_UNIVERSE = Symbol('identity.readAccountUniverse');
export const READ_UNIVERSE_ACCESS = Symbol('identity.readUniverseAccess');

// ── Sign-in and sessions (S1.3, D-022) ──────────────────────────────────────────────────────
// The use cases are implemented in `application/` and built by `adapters/nest-providers.ts`.

export {
  OPERATOR_WORLDS,
  SESSION_TTL_DAYS,
  SIGN_IN_LINK_TTL_MINUTES,
  operatorAddressMatcher,
} from './domain/policy.js';
export { SweepSignInRecordsPayloadSchema, sweepSignInRecordsQueue, type SweepSignInRecordsPayload } from './events.js';

/** Which client a session belongs to: a web cookie or a native bearer token. */
export type SessionClient = 'web' | 'native';

/** A valid session with the authority it carries now: account, universe and current epoch. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly accountId: string;
  /** The account's own address, for showing back to its owner (never logged). */
  readonly address: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly client: SessionClient;
  readonly expiresAt: Date;
}

/**
 * What one sign-in mail delivery achieved. `failed` carries a fixed reason and, when a response
 * was received, its HTTP status; never the address, link, token, key or a provider body.
 */
export type MailDelivery =
  | { readonly kind: 'sent' }
  | {
      readonly kind: 'failed';
      readonly reason: 'http_error' | 'timeout' | 'network_error' | 'malformed_response' | 'refused_in_transaction';
      readonly status?: number;
    };

/** The budget a refused sign-in request ran into (review M2). */
export type SignInBudget = 'address' | 'domain' | 'world';

export type RequestSignInResult =
  | {
      readonly kind: 'requested';
      /**
       * The mail delivery, already started after the link committed. It never rejects, and its
       * outcome is logged once; callers do not wait for it, so a slow or failing provider never
       * changes or delays the answer (no address oracle, D-007).
       */
      readonly delivery: Promise<MailDelivery>;
    }
  /**
   * `invalid_address`: outside the accepted grammar. `binding_not_enabled`: a native challenge
   * while native sign-in binding is off on this world (re-review N1).
   */
  | { readonly kind: 'refused'; readonly reason: 'invalid_address' | 'binding_not_enabled' }
  | { readonly kind: 'rate_limited'; readonly budget: SignInBudget; readonly retryAfterSeconds: number };

/** Use case: mail a single-use sign-in link (`application/request-sign-in.ts`). */
export type RequestSignIn = (input: {
  readonly email: string;
  /** Native only: base64url SHA-256 of the app's verifier (PKCE-style binding, review m10). */
  readonly codeChallenge?: string;
}) => Promise<RequestSignInResult>;

/**
 * Use case: which address a link signs into, without consuming it (review m8, re-review N6): the
 * full address for a web link, the masked one for a native link and only with its verifier.
 */
export type PeekSignInLink = (request: {
  readonly token: string;
  readonly client: SessionClient;
  readonly codeVerifier?: string;
}) => Promise<{ readonly kind: 'usable'; readonly email: string } | { readonly kind: 'link_invalid' }>;

export interface RedeemSignInCommand {
  /** The link token as presented (its shape is checked by the wire contract). */
  readonly token: string;
  /** Minted by the client once per redemption and reused on its retries. */
  readonly commandId: string;
  readonly client: SessionClient;
  /** Native: the verifier whose challenge the link was requested with (review m10). */
  readonly codeVerifier?: string;
}

export type RedeemRefusal =
  /**
   * Unknown, expired, redeemed by another command, bound to another device (PKCE), an operator
   * link where operator sign-in is off or for an address outside the pattern, or a replay whose
   * session has ended: one answer for each (A02).
   */
  | 'link_invalid'
  /** The account or its universe is suspended or missing. */
  | 'account_unavailable'
  | 'command_key_reused'
  | 'outcome_from_newer_release';

export type RedeemSignInResult =
  | {
      readonly kind: 'signed_in';
      readonly outcome: { readonly accountId: string; readonly universeId: string; readonly accountCreated: boolean };
      readonly privacyEpoch: number;
      readonly session: { readonly id: string; readonly token: string; readonly expiresAt: Date };
      readonly replayed: boolean;
      readonly origin: 'email' | 'operator';
      /** The link's address, for showing back to the person it belongs to (never logged). */
      readonly address: string;
    }
  | { readonly kind: 'refused'; readonly reason: RedeemRefusal };

/** Use case: exchange a sign-in link for a session (`application/redeem-sign-in.ts`). */
export type RedeemSignIn = (command: RedeemSignInCommand) => Promise<RedeemSignInResult>;

export type IssueOperatorSignInResult =
  | {
      readonly kind: 'issued';
      readonly outcome: { readonly accountId: string; readonly universeId: string; readonly accountCreated: boolean };
      /** The one-time link to print. Never logged or stored (only its hash is). */
      readonly link: string;
    }
  | {
      readonly kind: 'refused';
      /**
       * `address_not_allowed`: the address does not match the world's operator pattern;
       * `not_disposable`: its account proved the address by a mailed link.
       */
      readonly reason: 'invalid_address' | 'address_not_allowed' | 'not_disposable' | 'account_unavailable';
    };

/** Use case: mint an operator sign-in link for a disposable test account (`application/issue-operator-sign-in.ts`). */
export type IssueOperatorSignIn = (input: { readonly email: string }) => Promise<IssueOperatorSignInResult>;

/** Use case: the authority behind a presented session token, re-read now (`application/sessions.ts`). */
export type ResolveSession = (token: string) => Promise<ActiveSession | undefined>;

/** Use case: whether a session that authenticated a socket still holds. */
export type SessionValid = (session: { readonly sessionId: string; readonly accountId: string }) => Promise<boolean>;

/** Why sessions end: the person signed out (here or everywhere), or another sign-in replaced it. */
export type SessionEndReason = 'signed_out' | 'signed_out_everywhere' | 'replaced';

/** Use case: end this session, or every session of the account; drops the account's sockets. */
export type SignOut = (request: {
  readonly sessionId: string;
  readonly accountId: string;
  readonly everywhere: boolean;
  /** Defaults to signed out; an account switch on a device ends the old session as replaced. */
  readonly reason?: 'replaced';
}) => Promise<{ readonly revoked: number }>;

/** Use case: delete sign-in records past their retention (the scheduled sweep, review m12). */
export type SweepSignInRecords = () => Promise<{ readonly links: number; readonly sessions: number }>;

/** Injection tokens of identity's sign-in use cases (bound by the composition roots). */
export const REQUEST_SIGN_IN = Symbol('identity.requestSignIn');
export const PEEK_SIGN_IN_LINK = Symbol('identity.peekSignInLink');
export const REDEEM_SIGN_IN = Symbol('identity.redeemSignIn');
export const RESOLVE_SESSION = Symbol('identity.resolveSession');
export const SESSION_VALID = Symbol('identity.sessionValid');
export const SIGN_OUT = Symbol('identity.signOut');
export const SWEEP_SIGN_IN_RECORDS = Symbol('identity.sweepSignInRecords');

/** Current owning account status inside an already locked personal root, including for system
 * workers. Identity status mutations lock owning roots first. This observes account suspension,
 * not session/device sign-out; epoch/universe fencing remains with withPersonalScope.
 */
export type CheckPersonalOwnerActive = (scope: PersonalScopeTx) => Promise<boolean>;
export const CHECK_PERSONAL_OWNER_ACTIVE = Symbol('identity.checkPersonalOwnerActive');

/** Current Identity authority, valid only while its account fence transaction stays open.
 * Never use a saved snapshot as a reusable authorization capability.
 */
export interface AccountAccess {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
}
export type AccountAccessResult =
  { readonly kind: 'active'; readonly owner: AccountAccess } | { readonly kind: 'unavailable' };

/** Own root -> sorted exact-two account SHARE locks -> separate fresh authority read.
 * No peer root lock. Caller checks prepared epochs and shared membership before any effect/replay.
 */
export type FenceAccountPair = (
  scope: PersonalScopeTx,
  peerAccountId: string,
) => Promise<
  | { readonly kind: 'active'; readonly owner: AccountAccess; readonly peer: AccountAccess }
  | { readonly kind: 'unavailable' }
>;
/** Own root -> own account UPDATE. Must precede domain rows; never upgrade a pair gate. */
export type FenceOwnAccount = (scope: PersonalScopeTx) => Promise<AccountAccessResult>;
export type AccountInvalidationMode = 'advance_epoch' | 'suspend';
export type AccountInvalidation =
  | { readonly kind: 'invalidated'; readonly privacyEpoch: number; readonly revision: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'counter_exhausted' };
/** Internal authority barrier only: does not erase data or expose an HTTP privacy operation.
 * Suspension also advances epoch; reactivation must retain that newer epoch.
 */
export type InvalidateOwnAccountAccess = (
  authority: PersonalAuthority,
  mode: AccountInvalidationMode,
) => Promise<ScopeOutcome<AccountInvalidation>>;
export const FENCE_ACCOUNT_PAIR = Symbol('identity.fenceAccountPair');
export const FENCE_OWN_ACCOUNT = Symbol('identity.fenceOwnAccount');
export const INVALIDATE_OWN_ACCOUNT_ACCESS = Symbol('identity.invalidateOwnAccountAccess');

// Clear is an opt-in lifecycle. These capabilities never grant ordinary exploration authority.
declare const privacyScopeBrand: unique symbol;
declare const clearCoreBrand: unique symbol;
declare const clearAccountingBrand: unique symbol;
export interface PrivacyAuthority {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
}
export interface PrivacyScopeTx {
  readonly [privacyScopeBrand]: true;
  readonly authority: PrivacyAuthority;
  readonly revisionAtEntry: number;
  readonly barrierId: string | null;
}
export interface ClearBinding {
  readonly operationId: string;
  readonly accountId: string;
  readonly universeId: string;
  readonly commandId: string;
  readonly fromEpoch: number;
  readonly toEpoch: number;
}
export interface ClearCoreTx {
  readonly [clearCoreBrand]: true;
  readonly binding: ClearBinding;
}
export interface ClearAccountingTx {
  readonly [clearAccountingBrand]: true;
  readonly binding: ClearBinding;
  readonly liabilities: readonly ClearLiability[];
  readonly completed: boolean;
  readonly cleanupDueAt: string | null;
}
export interface ClearLiability {
  readonly attemptId: string;
  readonly runId: string;
  readonly roleId: string;
  readonly roleVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly budgetWindow: string;
  readonly reservedTokens: number;
}
export type WithPrivacyScope = <T>(
  authority: PrivacyAuthority,
  work: (scope: PrivacyScopeTx) => Promise<T>,
) => Promise<ScopeOutcome<T>>;
export type WithClearMaintenance = <T>(
  accountId: string,
  commandId: string,
  work: (scope: ClearCoreTx | ClearAccountingTx) => Promise<T>,
) => Promise<T | undefined>;
export { ClearExplorationJobSchema, clearExplorationQueue, type ClearExplorationJob } from './events.js';

export { ClearRecoveryJobSchema, recoverClearOperationsQueue, type ClearRecoveryJob } from './events.js';
