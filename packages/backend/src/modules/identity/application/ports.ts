import type { LogEvent } from '../../../infrastructure/observability/index.js';
import type {
  ActiveSession,
  MailDelivery,
  PersonalScopeTx,
  RootResolutionTx,
  SessionClient,
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
  /** The stored form of a presented token. */
  hashToken(token: string): string;
  /** A server-minted ID (UUIDv7). */
  newId(): string;
}

/** Who a sign-in link was made by: the person asking for mail, or an operator on dev/stage. */
export type LinkOrigin = 'email' | 'operator';

/** A sign-in link as redeem sees it, read under its address lock and its row lock. */
export interface LockedLink {
  readonly address: string;
  readonly origin: LinkOrigin;
  /** Past its expiry (database clock). */
  readonly expired: boolean;
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

export interface RequestSignInPorts {
  /**
   * In one short transaction under the address lock: the ages of the address's links in the
   * window, then (when admitted by `decide`) the new link, plus removal of links that expired more
   * than a day ago. Nothing is written when refused.
   */
  readonly createEmailLink: (request: {
    readonly address: string;
    readonly tokenHash: string;
    readonly limit: LinkLimit;
  }) => Promise<{ readonly kind: 'created' } | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number }>;
  readonly sendMail: MailSender;
  /** The link a person opens: `<public origin>/redeem#token=<token>`. */
  readonly linkFor: (token: string) => string;
  readonly secrets: IdentitySecrets;
  readonly logEvent: LogEvent;
  readonly now: () => number;
}

export interface RedeemSignInPorts extends ReceiptPorts, AccountRootPorts {
  readonly withResolvedPersonalScope: WithResolvedPersonalScope;
  /** Takes the link's address lock, then its row lock, and reads it; `undefined` for an unknown token. */
  readonly lockLink: (tx: RootResolutionTx, tokenHash: string) => Promise<LockedLink | undefined>;
  readonly findAccountById: (tx: RootResolutionTx, accountId: string) => Promise<AccountRoot | undefined>;
  readonly consumeLink: (
    tx: RootResolutionTx,
    tokenHash: string,
    consumed: { readonly commandId: string; readonly accountId: string },
  ) => Promise<void>;
  /**
   * Inserts one session inside the locked scope and removes the account's ended (expired or
   * revoked) sessions. Returns its expiry (database clock).
   */
  readonly issueSession: (
    scope: PersonalScopeTx,
    session: {
      readonly id: string;
      readonly accountId: string;
      readonly tokenHash: string;
      readonly client: SessionClient;
    },
  ) => Promise<{ readonly expiresAt: Date }>;
  readonly secrets: IdentitySecrets;
  /** Operator-minted links are accepted only where operator sign-in is enabled (never live). */
  readonly operatorSignInEnabled: boolean;
}

export interface IssueOperatorSignInPorts extends ReceiptPorts, AccountRootPorts {
  readonly withResolvedPersonalScope: WithResolvedPersonalScope;
  /** Inserts an operator link for the scope's own address. */
  readonly createOperatorLink: (
    scope: PersonalScopeTx,
    link: { readonly tokenHash: string; readonly address: string },
  ) => Promise<void>;
  readonly linkFor: (token: string) => string;
  readonly secrets: IdentitySecrets;
}

export interface SessionPorts {
  /** The session behind a token hash when it is unrevoked, unexpired and its account and universe are active. */
  readonly readActiveSession: (tokenHash: string) => Promise<ActiveSession | undefined>;
  /** Whether a session is still unrevoked and unexpired and its account active. */
  readonly sessionStillValid: (session: { readonly sessionId: string; readonly accountId: string }) => Promise<boolean>;
  /**
   * In one transaction: revokes the session (or every session of its account) and sends the
   * access-revocation notice that disconnects the account's sockets when it commits.
   */
  readonly revokeSessions: (request: {
    readonly sessionId: string;
    readonly accountId: string;
    readonly everywhere: boolean;
  }) => Promise<number>;
  readonly secrets: IdentitySecrets;
}
