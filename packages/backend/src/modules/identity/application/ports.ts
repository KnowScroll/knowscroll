import type { LogEvent } from '../../../infrastructure/observability/index.js';
import type {
  AccountInvalidation,
  AccountInvalidationMode,
  FenceOwnAccount,
  WithPersonalScope,
  ActiveSession,
  MailDelivery,
  PersonalScopeTx,
  RootResolutionTx,
  SessionClient,
  SessionEndReason,
  SignInBudget,
  WithResolvedPersonalScope,
} from '../public.js';
import type { LinkLimit } from '../domain/policy.js';

export type { ActiveSession, MailDelivery, SessionClient };

/** JSON a command request or outcome may contain. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A fresh secret and the SHA-256 (hex) stored in its place. The token itself is never stored. */
export interface Secret {
  readonly token: string;
  readonly hash: string;
}

/** Where sign-in secrets and IDs come from (crypto in production). */
export interface IdentitySecrets {
  /** A sign-in link token (`ksl_…`) and its hash. */
  newLinkSecret(): Secret;
  /** A session token (`kss_…`) and its hash. */
  newSessionSecret(): Secret;
  /** A one-time export download token (`kse_…`) and its hash. */
  newDownloadSecret(): Secret;
  /** The stored form of a presented token. */
  hashToken(token: string): string;
  /** The S256 challenge of a PKCE-style verifier: base64url SHA-256, without padding. */
  challengeOf(verifier: string): string;
  /** A server-minted ID (UUIDv7). */
  newId(): string;
}

/** Who a sign-in link was made by: the person asking for mail, or an operator on dev/stage. */
export type LinkOrigin = 'email' | 'operator';

/** A sign-in link as peek and redeem see it. */
export interface LinkRecord {
  readonly address: string;
  readonly origin: LinkOrigin;
  /** Past its expiry (database clock). */
  readonly expired: boolean;
  /** Native requests only: the verifier challenge the link is bound to. */
  readonly codeChallenge: string | undefined;
  /** Set once the link was redeemed: by which command, for which account. */
  readonly consumed: { readonly commandId: string; readonly accountId: string } | undefined;
}

/** An account with its universe root, found by address or by ID. */
export interface AccountRoot {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly disposable: boolean;
}

/** One mail as the sender sees it: the recipient and the link, nothing else. */
export interface SignInMail {
  readonly to: string;
  readonly link: string;
}

/**
 * Port: send one sign-in mail. One attempt, never a retry; resolves (never rejects) with what
 * happened. Implemented by the AgentMail adapter, and in tests only by the fixture sender.
 */
export type MailSender = (mail: SignInMail) => Promise<MailDelivery>;

/** The receipt store's view of a command key (infrastructure/receipts). */
export type CommandLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: unknown }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'epoch_mismatch' }
  | { readonly kind: 'outcome_version_newer' }
  | { readonly kind: 'outcome_version_older' };

export interface CommandKey {
  readonly commandId: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly outcomeVersion: number;
}

/** The receipt functions every identity command uses, bound to the receipts infrastructure. */
export interface ReceiptPorts {
  readonly hashRequest: (operation: string, request: JsonValue) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<CommandLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: { readonly [key: string]: JsonValue },
  ) => Promise<void>;
}

/** Finding and creating an account root inside the first phase of a resolved scope. */
export interface AccountRootPorts {
  /** Serialises everything that touches one address (`pg_advisory_xact_lock`): identity's first lock. */
  readonly lockAddress: (tx: RootResolutionTx, address: string) => Promise<void>;
  readonly findAccountByAddress: (tx: RootResolutionTx, address: string) => Promise<AccountRoot | undefined>;
  /** Inserts the account, its address and its universe root (privacy epoch 1) in this transaction. */
  readonly createAccount: (
    tx: RootResolutionTx,
    account: {
      readonly accountId: string;
      readonly universeId: string;
      readonly address: string;
      readonly disposable: boolean;
    },
  ) => Promise<void>;
}

/** A mailed-link budget in the shape the store checks it (review M2). */
export interface BudgetCheck {
  readonly budget: SignInBudget;
  readonly limit: LinkLimit;
}

export interface RequestSignInPorts {
  /**
   * In one short transaction: the address lock; then, in order, each budget (address, recipient
   * domain under the domain's advisory lock, world-wide under the world's), counting only email
   * links already issued; the first that is full refuses and nothing is written; otherwise the
   * new link (15 minutes, database clock).
   */
  readonly createEmailLink: (request: {
    readonly address: string;
    readonly domain: string;
    readonly tokenHash: string;
    readonly codeChallenge: string | undefined;
    readonly budgets: readonly BudgetCheck[];
  }) => Promise<
    | { readonly kind: 'created' }
    | { readonly kind: 'rate_limited'; readonly budget: SignInBudget; readonly retryAfterSeconds: number }
  >;
  readonly sendMail: MailSender;
  /** The link a person opens: `<public origin>/redeem#token=<token>`. */
  readonly linkFor: (token: string) => string;
  readonly secrets: IdentitySecrets;
  readonly logEvent: LogEvent;
  /** Milliseconds, for durations and the once-per-window budget alert. */
  readonly now: () => number;
  /** `KS_NATIVE_SIGN_IN_BINDING=1`: native code challenges are accepted (re-review N1). */
  readonly nativeBinding: boolean;
}

export interface PeekSignInPorts {
  /** The link behind a token hash (no lock, read-only), or `undefined`. */
  readonly readLink: (tokenHash: string) => Promise<LinkRecord | undefined>;
  /** Whether operator links may be redeemed here for this address (pattern, world, flag). */
  readonly operatorAddressAllowed: (address: string) => boolean;
  readonly secrets: IdentitySecrets;
}

export interface RedeemSignInPorts extends ReceiptPorts, AccountRootPorts {
  readonly withResolvedPersonalScope: WithResolvedPersonalScope;
  /** Takes the link's address lock, then its row lock, and reads it; `undefined` for an unknown token. */
  readonly lockLink: (tx: RootResolutionTx, tokenHash: string) => Promise<LinkRecord | undefined>;
  readonly findAccountById: (tx: RootResolutionTx, accountId: string) => Promise<AccountRoot | undefined>;
  readonly consumeLink: (
    tx: RootResolutionTx,
    tokenHash: string,
    consumed: { readonly commandId: string; readonly accountId: string },
  ) => Promise<void>;
  /**
   * The address proved itself by a mailed link (review m2): its account stops being disposable,
   * so no operator link is issued for it again. Under the address lock.
   */
  readonly markAddressProved: (tx: RootResolutionTx, accountId: string) => Promise<void>;
  /**
   * Inserts one session inside the locked scope, issued by `issuedByCommand`, and removes the
   * account's ended (expired or revoked) sessions. Returns its expiry (database clock).
   */
  readonly issueSession: (
    scope: PersonalScopeTx,
    session: {
      readonly id: string;
      readonly accountId: string;
      readonly tokenHash: string;
      readonly client: SessionClient;
      readonly issuedByCommand: string;
      /** The coarse label Account shows for this device (`deviceLabelOf`). */
      readonly deviceLabel?: string;
    },
  ) => Promise<{ readonly expiresAt: Date }>;
  /**
   * A replay's guard (review m5): revokes, as replaced, the account's live sessions issued by this
   * redemption command, and answers how many there were. None means the redemption's session has
   * ended (signed out, revoked, expired): the replay is refused.
   */
  readonly replaceCommandSessions: (
    scope: PersonalScopeTx,
    request: { readonly accountId: string; readonly commandId: string },
  ) => Promise<number>;
  /** Whether operator links may be redeemed here for this address (pattern, world, flag). */
  readonly operatorAddressAllowed: (address: string) => boolean;
  readonly secrets: IdentitySecrets;
}

export interface IssueOperatorSignInPorts extends ReceiptPorts, AccountRootPorts {
  readonly withResolvedPersonalScope: WithResolvedPersonalScope;
  /** Whether the world's operator pattern admits this address (review m2). */
  readonly operatorAddressAllowed: (address: string) => boolean;
  /** Inserts an operator link for the scope's own address. */
  readonly createOperatorLink: (
    scope: PersonalScopeTx,
    link: { readonly tokenHash: string; readonly address: string; readonly domain: string },
  ) => Promise<void>;
  /** The durable audit row (`ops.operator_sign_ins`, review m9), in the issuing transaction. */
  readonly recordOperatorIssue: (
    scope: PersonalScopeTx,
    audit: { readonly id: string; readonly accountId: string; readonly accountCreated: boolean },
  ) => Promise<void>;
  readonly linkFor: (token: string) => string;
  readonly secrets: IdentitySecrets;
}

export interface SessionPorts {
  /** The session behind a token hash when it is unrevoked, unexpired and its account and universe are active. */
  readonly readActiveSession: (tokenHash: string) => Promise<ActiveSession | undefined>;
  /** Whether a session is still unrevoked and unexpired and its account and universe active. */
  readonly sessionStillValid: (session: { readonly sessionId: string; readonly accountId: string }) => Promise<boolean>;
  /**
   * In one transaction: revokes the session (or every session of its account) and sends the
   * access-revocation notice that disconnects the account's sockets when it commits.
   */
  readonly revokeSessions: (request: {
    readonly sessionId: string;
    readonly accountId: string;
    /** `session` ends `sessionId`; `every_session` ends all; `other_sessions` ends all but `sessionId`. */
    readonly target: 'session' | 'every_session' | 'other_sessions';
    readonly reason: SessionEndReason;
  }) => Promise<number>;
  /** The account's live sessions, newest use first, at most `SESSION_LIST_LIMIT`. */
  readonly listLiveSessions: (accountId: string) => Promise<readonly LiveSession[]>;
  readonly secrets: IdentitySecrets;
}

/** One live session as the owner sees it in Account. No token, hash or address. */
export interface LiveSession {
  readonly id: string;
  readonly client: SessionClient;
  readonly deviceLabel: string | null;
  readonly signedInAt: Date;
  readonly lastUsedAt: Date | null;
}

export interface SweepPorts {
  /**
   * Deletes links a day past expiry and sessions 30 days past their end, in bounded batches, and
   * retires exports: files past their expiry, builds stuck for half an hour, receipts after 30 days.
   */
  readonly sweep: () => Promise<{ readonly links: number; readonly sessions: number; readonly exports: number }>;
}

/** Exact Identity lifecycle effects; no arbitrary transaction callback crosses this boundary. */
export interface AccountLifecyclePorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly advance: (
    scope: PersonalScopeTx,
    mode: AccountInvalidationMode,
  ) => Promise<Extract<AccountInvalidation, { kind: 'invalidated' }>>;
}
