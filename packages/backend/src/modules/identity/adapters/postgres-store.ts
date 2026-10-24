import { sql, type Kysely, type Transaction } from 'kysely';
import { revokeAccountSockets } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  resolutionTransactionOf,
  transactionOf,
  withTransaction,
} from '../../../infrastructure/postgres/personal-scope.js';
import type {
  AccountRoot,
  ActiveSession,
  BudgetCheck,
  LinkOrigin,
  LinkRecord,
  LiveSession,
  SessionClient,
} from '../application/ports.js';
import {
  admitLink,
  SESSION_LIST_LIMIT,
  SESSION_TOUCH_MINUTES,
  SESSION_TTL_DAYS,
  SIGN_IN_LINK_TTL_MINUTES,
} from '../domain/policy.js';
import type {
  AccountUniverse,
  PersonalScopeTx,
  RootResolutionTx,
  SessionEndReason,
  SignInBudget,
  UniverseAccess,
} from '../public.js';

/** Reads an account and its universe (read-only, no lock). One universe per account (unique). */
export async function readAccountUniverse(
  db: Kysely<Database>,
  accountId: string,
): Promise<AccountUniverse | undefined> {
  return db
    .selectFrom('identity.accounts as account')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'account.id')
    .select([
      'account.id as accountId',
      'account.status as accountStatus',
      'universe.id as universeId',
      'universe.status as universeStatus',
      'universe.privacy_epoch as privacyEpoch',
    ])
    .where('account.id', '=', accountId)
    .executeTakeFirst();
}

/** Reads the address of an active account (read-only, no lock). One address per account. */
export async function readAccountAddress(db: Kysely<Database>, accountId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('identity.email_addresses as email')
    .innerJoin('identity.accounts as account', 'account.id', 'email.account_id')
    .select('email.address')
    .where('email.account_id', '=', accountId)
    .where('account.status', '=', 'active')
    .executeTakeFirst();
  return row?.address;
}

/** Reads one universe's access state for its owner (read-only, no lock). */
export async function readUniverseAccess(
  db: Kysely<Database>,
  accountId: string,
  universeId: string,
): Promise<UniverseAccess | undefined> {
  const row = await db
    .selectFrom('identity.universes as universe')
    .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
    .select([
      'universe.revision',
      'universe.privacy_epoch',
      'universe.status',
      'universe.clear_operation_id',
      'account.status as account_status',
    ])
    .where('universe.id', '=', universeId)
    .where('universe.account_id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    revision: row.revision,
    privacyEpoch: row.privacy_epoch,
    active: row.status === 'active' && row.account_status === 'active' && row.clear_operation_id === null,
  };
}

// ── Sign-in: identity's lock order is address → (domain, world budget) → link → personal root. ──

/**
 * Identity's first lock: a transaction-scoped advisory lock on one address. Everything that reads
 * then writes an address's links or creates its account takes it first, so two links for one new
 * address, or two retries of one redemption, never create two accounts.
 */
export async function lockAddressIn(trx: Transaction<Database>, address: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`identity.address:${address}`}, 0))`.execute(trx);
}

export async function lockAddress(tx: RootResolutionTx, address: string): Promise<void> {
  await lockAddressIn(resolutionTransactionOf(tx), address);
}

const linkColumns = [
  'address',
  'origin',
  'code_challenge',
  'consumed_command_id',
  'consumed_account_id',
  sql<boolean>`expires_at <= now()`.as('expired'),
] as const;

function linkRecord(row: {
  readonly address: string;
  readonly origin: string;
  readonly code_challenge: string | null;
  readonly consumed_command_id: string | null;
  readonly consumed_account_id: string | null;
  readonly expired: boolean;
}): LinkRecord {
  return {
    address: row.address,
    origin: row.origin as LinkOrigin,
    expired: row.expired,
    codeChallenge: row.code_challenge ?? undefined,
    consumed:
      row.consumed_command_id === null || row.consumed_account_id === null
        ? undefined
        : { commandId: row.consumed_command_id, accountId: row.consumed_account_id },
  };
}

/**
 * Reads the link's address (no lock), takes the address lock, then re-reads the link `FOR
 * UPDATE`: after the wait it reflects any redemption that committed meanwhile.
 */
export async function lockLink(tx: RootResolutionTx, tokenHash: string): Promise<LinkRecord | undefined> {
  const trx = resolutionTransactionOf(tx);
  const first = await trx
    .selectFrom('identity.sign_in_links')
    .select('address')
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  if (first === undefined) return undefined;
  await lockAddressIn(trx, first.address);
  const row = await trx
    .selectFrom('identity.sign_in_links')
    .select(linkColumns)
    .where('token_hash', '=', tokenHash)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : linkRecord(row);
}

/** The link behind a token hash, read without a lock (peek). */
export async function readLink(db: Kysely<Database>, tokenHash: string): Promise<LinkRecord | undefined> {
  const row = await db
    .selectFrom('identity.sign_in_links')
    .select(linkColumns)
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();
  return row === undefined ? undefined : linkRecord(row);
}

function accountRoots(trx: Transaction<Database>) {
  return trx
    .selectFrom('identity.email_addresses as email')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'email.account_id')
    .select([
      'email.account_id as accountId',
      'universe.id as universeId',
      'universe.privacy_epoch as privacyEpoch',
      'email.disposable as disposable',
    ]);
}

export async function findAccountByAddress(tx: RootResolutionTx, address: string): Promise<AccountRoot | undefined> {
  return accountRoots(resolutionTransactionOf(tx)).where('email.address', '=', address).executeTakeFirst();
}

export async function findAccountById(tx: RootResolutionTx, accountId: string): Promise<AccountRoot | undefined> {
  return accountRoots(resolutionTransactionOf(tx)).where('email.account_id', '=', accountId).executeTakeFirst();
}

/** Inserts an account, its address and its universe root (privacy epoch 1), in this transaction. */
export async function createAccount(
  tx: RootResolutionTx,
  account: {
    readonly accountId: string;
    readonly universeId: string;
    readonly address: string;
    readonly disposable: boolean;
  },
): Promise<void> {
  const trx = resolutionTransactionOf(tx);
  await trx.insertInto('identity.accounts').values({ id: account.accountId }).execute();
  await trx
    .insertInto('identity.email_addresses')
    .values({ account_id: account.accountId, address: account.address, disposable: account.disposable })
    .execute();
  await trx
    .insertInto('identity.universes')
    .values({
      id: account.universeId,
      account_id: account.accountId,
      privacy_epoch: 1,
      recording_lifecycle_protocol: 1,
    })
    .execute();
}

/** Marks the (row-locked, unconsumed) link redeemed by `commandId` for `accountId`. */
export async function consumeLink(
  tx: RootResolutionTx,
  tokenHash: string,
  consumed: { readonly commandId: string; readonly accountId: string },
): Promise<void> {
  const result = await resolutionTransactionOf(tx)
    .updateTable('identity.sign_in_links')
    .set({
      consumed_at: sql`now()`,
      consumed_command_id: consumed.commandId,
      consumed_account_id: consumed.accountId,
    })
    .where('token_hash', '=', tokenHash)
    .where('consumed_at', 'is', null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('Sign-in link to consume was not pending');
}

/** The address proved itself by a mailed link: the account is no longer disposable (review m2). */
export async function markAddressProved(tx: RootResolutionTx, accountId: string): Promise<void> {
  await resolutionTransactionOf(tx)
    .updateTable('identity.email_addresses')
    .set({ disposable: false })
    .where('account_id', '=', accountId)
    .where('disposable', '=', true)
    .execute();
}

const linkLifetime = sql<Date>`now() + make_interval(mins => ${SIGN_IN_LINK_TTL_MINUTES})`;

/**
 * The budgets' own locks (re-review N4): a domain's, then the world's, always after the address
 * lock, so concurrent requests for different addresses cannot both count the same last slot.
 */
const WORLD_BUDGET_LOCK = 'identity.world-sign-in-budget';
const domainBudgetLock = (domain: string) => `identity.domain:${domain}`;

/**
 * The ages (seconds) of the newest email links a budget counts, at most `max` of them: enough to
 * decide admission and, when full, when the next link fits (`admitLink`).
 */
async function budgetAges(
  trx: Transaction<Database>,
  budget: SignInBudget,
  key: { readonly address: string; readonly domain: string },
  check: BudgetCheck,
): Promise<readonly number[]> {
  let query = trx
    .selectFrom('identity.sign_in_links')
    .select(sql<number>`extract(epoch from now() - created_at)::float8`.as('age'))
    .where('origin', '=', 'email')
    .where('created_at', '>', sql<Date>`now() - make_interval(secs => ${check.limit.windowSeconds})`);
  if (budget === 'address') query = query.where('address', '=', key.address);
  if (budget === 'domain') query = query.where('domain', '=', key.domain);
  const rows = await query.orderBy('created_at', 'desc').limit(check.limit.max).execute();
  return rows.map((row) => Number(row.age));
}

/**
 * One short transaction: the address lock; each budget in order (address, then, under the
 * domain's own lock, domain, then, under the world's, world-wide), counting only email links
 * already issued; the
 * first full one refuses with nothing written; otherwise the new link. Old links are removed by
 * the scheduled sweep, never here.
 */
export function makeCreateEmailLink(db: Kysely<Database>, options: { readonly lockTimeoutMs: number }) {
  return (request: {
    readonly address: string;
    readonly domain: string;
    readonly tokenHash: string;
    readonly codeChallenge: string | undefined;
    readonly budgets: readonly BudgetCheck[];
  }) =>
    withTransaction(db, 'identity.request-sign-in', async (trx) => {
      await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true)`.execute(trx);
      await lockAddressIn(trx, request.address);
      for (const check of request.budgets) {
        if (check.budget === 'domain')
          await sql`select pg_advisory_xact_lock(hashtextextended(${domainBudgetLock(request.domain)}, 0))`.execute(
            trx,
          );
        if (check.budget === 'world')
          await sql`select pg_advisory_xact_lock(hashtextextended(${WORLD_BUDGET_LOCK}, 0))`.execute(trx);
        const admission = admitLink(await budgetAges(trx, check.budget, request, check), check.limit);
        if (admission.kind === 'rate_limited')
          return {
            kind: 'rate_limited' as const,
            budget: check.budget,
            retryAfterSeconds: admission.retryAfterSeconds,
          };
      }
      await trx
        .insertInto('identity.sign_in_links')
        .values({
          token_hash: request.tokenHash,
          address: request.address,
          domain: request.domain,
          origin: 'email',
          code_challenge: request.codeChallenge ?? null,
          expires_at: linkLifetime,
        })
        .execute();
      return { kind: 'created' as const };
    });
}

/** Inserts an operator link for the scope's account, inside its locked scope. */
export async function createOperatorLink(
  scope: PersonalScopeTx,
  link: { readonly tokenHash: string; readonly address: string; readonly domain: string },
): Promise<void> {
  await transactionOf(scope)
    .insertInto('identity.sign_in_links')
    .values({
      token_hash: link.tokenHash,
      address: link.address,
      domain: link.domain,
      origin: 'operator',
      expires_at: linkLifetime,
    })
    .execute();
}

/**
 * The operator audit row (`ops.operator_sign_ins`, review m9), in the issuing transaction: the
 * world, the time, who ran the command and the account it opens.
 */
export function makeRecordOperatorIssue(context: { readonly world: string; readonly operatorSource: string }) {
  return async (
    scope: PersonalScopeTx,
    audit: { readonly id: string; readonly accountId: string; readonly accountCreated: boolean },
  ): Promise<void> => {
    await transactionOf(scope)
      .insertInto('ops.operator_sign_ins')
      .values({
        id: audit.id,
        world: context.world,
        operator_source: context.operatorSource,
        account_id: audit.accountId,
        account_created: audit.accountCreated,
      })
      .execute();
  };
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────

/**
 * Inserts a session (expiring after `SESSION_TTL_DAYS`, database clock) inside the locked scope,
 * after removing the account's ended sessions, so an account keeps only its live ones.
 */
export async function issueSession(
  scope: PersonalScopeTx,
  session: {
    readonly id: string;
    readonly accountId: string;
    readonly tokenHash: string;
    readonly client: SessionClient;
    readonly issuedByCommand: string;
    readonly deviceLabel?: string;
  },
): Promise<{ readonly expiresAt: Date }> {
  const trx = transactionOf(scope);
  await trx
    .deleteFrom('identity.sessions')
    .where('account_id', '=', session.accountId)
    .where((eb) => eb.or([eb('revoked_at', 'is not', null), eb('expires_at', '<=', sql<Date>`now()`)]))
    .execute();
  const row = await trx
    .insertInto('identity.sessions')
    .values({
      id: session.id,
      account_id: session.accountId,
      token_hash: session.tokenHash,
      client: session.client,
      issued_by_command: session.issuedByCommand,
      device_label: session.deviceLabel ?? null,
      last_used_at: sql<Date>`now()`,
      expires_at: sql<Date>`now() + make_interval(days => ${SESSION_TTL_DAYS})`,
    })
    .returning('expires_at')
    .executeTakeFirstOrThrow();
  return { expiresAt: row.expires_at };
}

/**
 * A replay's guard (review m5): revokes, as replaced, the account's live sessions issued by this
 * redemption command inside the locked scope, and answers how many there were.
 */
export async function replaceCommandSessions(
  scope: PersonalScopeTx,
  request: { readonly accountId: string; readonly commandId: string },
): Promise<number> {
  const result = await transactionOf(scope)
    .updateTable('identity.sessions')
    .set({ revoked_at: sql`now()`, revoked_reason: 'replaced' })
    .where('account_id', '=', request.accountId)
    .where('issued_by_command', '=', request.commandId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

/** The live session behind a token hash, with its account's current universe and epoch. */
export async function readActiveSession(db: Kysely<Database>, tokenHash: string): Promise<ActiveSession | undefined> {
  const row = await db
    // Records use for Account's "Last used", at most every few minutes, in the same statement.
    .with('touched', (touch) =>
      touch
        .updateTable('identity.sessions')
        .set({ last_used_at: sql<Date>`now()` })
        .where('token_hash', '=', tokenHash)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', sql<Date>`now()`)
        .where((eb) =>
          eb.or([
            eb('last_used_at', 'is', null),
            eb('last_used_at', '<', sql<Date>`now() - make_interval(mins => ${SESSION_TOUCH_MINUTES})`),
          ]),
        )
        .returning('id'),
    )
    .selectFrom('identity.sessions as session')
    .innerJoin('identity.accounts as account', 'account.id', 'session.account_id')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'session.account_id')
    .innerJoin('identity.email_addresses as email', 'email.account_id', 'session.account_id')
    .select([
      'session.id as sessionId',
      'session.account_id as accountId',
      'email.address as address',
      'session.client as client',
      'session.expires_at as expiresAt',
      'universe.id as universeId',
      'universe.privacy_epoch as privacyEpoch',
    ])
    .where('session.token_hash', '=', tokenHash)
    .where('session.revoked_at', 'is', null)
    .where('session.expires_at', '>', sql<Date>`now()`)
    .where('account.status', '=', 'active')
    .where('universe.status', '=', 'active')
    .executeTakeFirst();
  return row === undefined ? undefined : { ...row, client: row.client as SessionClient };
}

/** Whether a session is still unrevoked and unexpired and its account and universe active. */
export async function sessionStillValid(
  db: Kysely<Database>,
  session: { readonly sessionId: string; readonly accountId: string },
): Promise<boolean> {
  const row = await db
    .selectFrom('identity.sessions as session')
    .innerJoin('identity.accounts as account', 'account.id', 'session.account_id')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'session.account_id')
    .select('session.id')
    .where('session.id', '=', session.sessionId)
    .where('session.account_id', '=', session.accountId)
    .where('session.revoked_at', 'is', null)
    .where('session.expires_at', '>', sql<Date>`now()`)
    .where('account.status', '=', 'active')
    .where('universe.status', '=', 'active')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Revokes one session (or all of an account's live sessions) and, in the same transaction, sends
 * the access-revocation notice so every API process drops the account's sockets on commit.
 */
export function makeRevokeSessions(db: Kysely<Database>) {
  return (request: {
    readonly sessionId: string;
    readonly accountId: string;
    readonly target: 'session' | 'every_session' | 'other_sessions';
    readonly reason: SessionEndReason;
  }) =>
    withTransaction(db, 'identity.sign-out', async (trx) => {
      let update = trx
        .updateTable('identity.sessions')
        .set({ revoked_at: sql`now()`, revoked_reason: request.reason })
        .where('account_id', '=', request.accountId)
        .where('revoked_at', 'is', null);
      if (request.target === 'session') update = update.where('id', '=', request.sessionId);
      if (request.target === 'other_sessions') update = update.where('id', '<>', request.sessionId);
      const result = await update.executeTakeFirst();
      const revoked = Number(result.numUpdatedRows);
      if (revoked > 0) await revokeAccountSockets(trx, request.accountId);
      return revoked;
    });
}

/** The account's live sessions, most recently used first (never a token or its hash). */
export async function listLiveSessions(db: Kysely<Database>, accountId: string): Promise<readonly LiveSession[]> {
  const rows = await db
    .selectFrom('identity.sessions')
    .select(['id', 'client', 'device_label', 'created_at', 'last_used_at'])
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', sql<Date>`now()`)
    .orderBy(sql`coalesce(last_used_at, created_at)`, 'desc')
    .limit(SESSION_LIST_LIMIT)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    client: row.client as SessionClient,
    deviceLabel: row.device_label,
    signedInAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/** Rows one sweep batch deletes per table; a sweep runs at most this many batches per table. */
const SWEEP_BATCH = 500;
const SWEEP_BATCHES = 20;

/**
 * The scheduled sweep (review m12): links a day past expiry and sessions 30 days past their end
 * (expiry or revocation), each in short transactions of at most 500 rows chosen with `FOR UPDATE
 * SKIP LOCKED`, so it never waits for or deadlocks with a sign-in holding a row.
 */
export function makeSweep(db: Kysely<Database>) {
  const sweepLinks = sql`
    delete from identity.sign_in_links
    where token_hash in (
      select token_hash from identity.sign_in_links
      where expires_at < now() - interval '1 day'
      order by expires_at
      limit ${SWEEP_BATCH}
      for update skip locked
    )`;
  const sweepSessions = sql`
    delete from identity.sessions
    where id in (
      select id from identity.sessions
      where (revoked_at is not null and revoked_at < now() - interval '30 days')
         or expires_at < now() - interval '30 days'
      order by expires_at
      limit ${SWEEP_BATCH}
      for update skip locked
    )`;
  // Export retirement: a ready file goes at its expiry (the receipt stays), a build stuck for half
  // an hour is failed so Account offers Retry, and receipts themselves go after 30 days.
  const expireExports = sql`
    update identity.data_exports
    set state = 'expired', payload = null, link_hash = null, link_expires_at = null
    where id in (
      select id from identity.data_exports
      where state = 'ready' and expires_at <= now()
      order by expires_at
      limit ${SWEEP_BATCH}
      for update skip locked
    )`;
  const failStuckExports = sql`
    update identity.data_exports set state = 'failed'
    where id in (
      select id from identity.data_exports
      where state = 'preparing' and requested_at < now() - interval '30 minutes'
      order by requested_at
      limit ${SWEEP_BATCH}
      for update skip locked
    )`;
  const deleteOldExports = sql`
    delete from identity.data_exports
    where id in (
      select id from identity.data_exports
      where state <> 'preparing' and requested_at < now() - interval '30 days'
      order by requested_at
      limit ${SWEEP_BATCH}
      for update skip locked
    )`;
  async function inBatches(purpose: string, statement: typeof sweepLinks): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < SWEEP_BATCHES; batch += 1) {
      const result = await withTransaction(db, purpose, (trx) => statement.execute(trx));
      const count = Number(result.numAffectedRows ?? 0n);
      removed += count;
      if (count < SWEEP_BATCH) break;
    }
    return removed;
  }
  return async () => ({
    links: await inBatches('identity.sweep-links', sweepLinks),
    sessions: await inBatches('identity.sweep-sessions', sweepSessions),
    exports:
      (await inBatches('identity.sweep-exports-expire', expireExports)) +
      (await inBatches('identity.sweep-exports-stuck', failStuckExports)) +
      (await inBatches('identity.sweep-exports-delete', deleteOldExports)),
  });
}
