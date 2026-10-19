import { sql, type Kysely, type Transaction } from 'kysely';
import { revokeAccountSockets } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  resolutionTransactionOf,
  transactionOf,
  withTransaction,
} from '../../../infrastructure/postgres/personal-scope.js';
import type { AccountRoot, ActiveSession, LinkOrigin, LockedLink, SessionClient } from '../application/ports.js';
import { admitLink, SESSION_TTL_DAYS, SIGN_IN_LINK_TTL_MINUTES, type LinkLimit } from '../domain/policy.js';
import type { AccountUniverse, PersonalScopeTx, RootResolutionTx, UniverseAccess } from '../public.js';

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

/** Reads one universe's access state for its owner (read-only, no lock). */
export async function readUniverseAccess(
  db: Kysely<Database>,
  accountId: string,
  universeId: string,
): Promise<UniverseAccess | undefined> {
  const row = await db
    .selectFrom('identity.universes as universe')
    .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
    .select(['universe.revision', 'universe.privacy_epoch', 'universe.status', 'account.status as account_status'])
    .where('universe.id', '=', universeId)
    .where('universe.account_id', '=', accountId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    revision: row.revision,
    privacyEpoch: row.privacy_epoch,
    active: row.status === 'active' && row.account_status === 'active',
  };
}

// ── Sign-in: identity's lock order is address → sign-in link → personal root. ──────────────────

/**
 * Identity's first lock: a transaction-scoped advisory lock on one address. Everything that reads
 * then writes an address's links or creates its account takes it first, so two links for one new
 * address, or two retries of one redemption, never create two accounts.
 */
async function lockAddressIn(trx: Transaction<Database>, address: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`identity.address:${address}`}, 0))`.execute(trx);
}

export async function lockAddress(tx: RootResolutionTx, address: string): Promise<void> {
  await lockAddressIn(resolutionTransactionOf(tx), address);
}

/**
 * Reads the link's address (no lock), takes the address lock, then re-reads the link `FOR
 * UPDATE`: after the wait it reflects any redemption that committed meanwhile.
 */
export async function lockLink(tx: RootResolutionTx, tokenHash: string): Promise<LockedLink | undefined> {
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
    .select([
      'address',
      'origin',
      'consumed_command_id',
      'consumed_account_id',
      sql<boolean>`expires_at <= now()`.as('expired'),
    ])
    .where('token_hash', '=', tokenHash)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    address: row.address,
    origin: row.origin as LinkOrigin,
    expired: row.expired,
    consumed:
      row.consumed_command_id === null || row.consumed_account_id === null
        ? undefined
        : { commandId: row.consumed_command_id, accountId: row.consumed_account_id },
  };
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
    .values({ id: account.universeId, account_id: account.accountId, privacy_epoch: 1 })
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

const linkLifetime = sql<Date>`now() + make_interval(mins => ${SIGN_IN_LINK_TTL_MINUTES})`;

/** Removes at most 100 links that expired over a day ago (personal data kept no longer). */
async function removeOldLinks(trx: Transaction<Database>): Promise<void> {
  await sql`
    delete from identity.sign_in_links
    where token_hash in (
      select token_hash from identity.sign_in_links
      where expires_at < now() - interval '1 day'
      limit 100
    )`.execute(trx);
}

/**
 * One short transaction under the address lock: the ages of the address's links inside the
 * window, the admission decision (`admitLink`), then the new email link and the removal of old
 * links. Nothing is written when the address is rate-limited.
 */
export function makeCreateEmailLink(db: Kysely<Database>, options: { readonly lockTimeoutMs: number }) {
  return (request: { readonly address: string; readonly tokenHash: string; readonly limit: LinkLimit }) =>
    withTransaction(db, 'identity.request-sign-in', async (trx) => {
      await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true)`.execute(trx);
      await lockAddressIn(trx, request.address);
      const recent = await trx
        .selectFrom('identity.sign_in_links')
        .select(sql<number>`extract(epoch from now() - created_at)::float8`.as('age'))
        .where('address', '=', request.address)
        .where('created_at', '>', sql<Date>`now() - make_interval(secs => ${request.limit.windowSeconds})`)
        .execute();
      const admission = admitLink(
        recent.map((row) => Number(row.age)),
        request.limit,
      );
      if (admission.kind === 'rate_limited') return admission;
      await trx
        .insertInto('identity.sign_in_links')
        .values({ token_hash: request.tokenHash, address: request.address, origin: 'email', expires_at: linkLifetime })
        .execute();
      await removeOldLinks(trx);
      return { kind: 'created' as const };
    });
}

/** Inserts an operator link for the scope's account, inside its locked scope. */
export async function createOperatorLink(
  scope: PersonalScopeTx,
  link: { readonly tokenHash: string; readonly address: string },
): Promise<void> {
  const trx = transactionOf(scope);
  await trx
    .insertInto('identity.sign_in_links')
    .values({ token_hash: link.tokenHash, address: link.address, origin: 'operator', expires_at: linkLifetime })
    .execute();
  await removeOldLinks(trx);
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
      expires_at: sql<Date>`now() + make_interval(days => ${SESSION_TTL_DAYS})`,
    })
    .returning('expires_at')
    .executeTakeFirstOrThrow();
  return { expiresAt: row.expires_at };
}

/** The live session behind a token hash, with its account's current universe and epoch. */
export async function readActiveSession(db: Kysely<Database>, tokenHash: string): Promise<ActiveSession | undefined> {
  const row = await db
    .selectFrom('identity.sessions as session')
    .innerJoin('identity.accounts as account', 'account.id', 'session.account_id')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'session.account_id')
    .select([
      'session.id as sessionId',
      'session.account_id as accountId',
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

/** Whether a session is still unrevoked and unexpired and its account active. */
export async function sessionStillValid(
  db: Kysely<Database>,
  session: { readonly sessionId: string; readonly accountId: string },
): Promise<boolean> {
  const row = await db
    .selectFrom('identity.sessions as session')
    .innerJoin('identity.accounts as account', 'account.id', 'session.account_id')
    .select('session.id')
    .where('session.id', '=', session.sessionId)
    .where('session.account_id', '=', session.accountId)
    .where('session.revoked_at', 'is', null)
    .where('session.expires_at', '>', sql<Date>`now()`)
    .where('account.status', '=', 'active')
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Revokes one session (or all of an account's live sessions) and, in the same transaction, sends
 * the access-revocation notice so every API process drops the account's sockets on commit.
 */
export function makeRevokeSessions(db: Kysely<Database>) {
  return (request: { readonly sessionId: string; readonly accountId: string; readonly everywhere: boolean }) =>
    withTransaction(db, 'identity.sign-out', async (trx) => {
      let update = trx
        .updateTable('identity.sessions')
        .set({
          revoked_at: sql`now()`,
          revoked_reason: request.everywhere ? 'signed_out_everywhere' : 'signed_out',
        })
        .where('account_id', '=', request.accountId)
        .where('revoked_at', 'is', null);
      if (!request.everywhere) update = update.where('id', '=', request.sessionId);
      const result = await update.executeTakeFirst();
      const revoked = Number(result.numUpdatedRows);
      if (revoked > 0) await revokeAccountSockets(trx, request.accountId);
      return revoked;
    });
}
