import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * The Universe tab's first-open animation belongs to the account (D-114, #470). Evidence label: real
 * sign-in through the identity use cases against a real PostgreSQL 16 database, fixture addresses.
 */
const settings: IdentitySettings = {
  publicOrigin: 'https://app.ci.invalid',
  secureCookies: true,
  mail: { sender: 'fixture', outboxFile: undefined },
  operatorSignIn: undefined,
  nativeSignInBinding: false,
};

describe('claiming the first open (real database)', () => {
  let database: TestDatabase<Database>;
  const mail: { to: string; link: string }[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('account_first_open');
  });
  afterAll(async () => {
    await database.drop();
  });

  const identity = () =>
    identityUseCases({
      db: database.db,
      settings,
      lockTimeoutMs: 5_000,
      logEvent: () => undefined,
      mailSender: (message) => {
        mail.push(message);
        return Promise.resolve({ kind: 'sent' });
      },
    });

  async function signIn(address: string): Promise<string> {
    const use = identity();
    const requested = await use.requestSignIn({ email: address });
    if (requested.kind !== 'requested') throw new Error('not requested');
    await requested.delivery;
    const token = new URL(mail.at(-1)?.link ?? '').hash.replace(/^#token=/, '');
    const result = await use.redeemSignIn({ token, commandId: randomUUID(), client: 'web' });
    if (result.kind !== 'signed_in') throw new Error('refused');
    return result.outcome.accountId;
  }

  const address = () => `first-open-${randomUUID()}@first-open.test`;

  it('is claimed once in the lifetime of the account, on any device, and never again', async () => {
    const use = identity();
    const accountId = await signIn(address());
    expect(await use.claimFirstOpen({ accountId })).toEqual({ claimed: true });
    // A second device, a reinstall and a repeat all get the same answer.
    expect(await use.claimFirstOpen({ accountId })).toEqual({ claimed: false });
    expect(await use.claimFirstOpen({ accountId })).toEqual({ claimed: false });
  });

  it('goes to exactly one of two devices that open the tab at the same moment', async () => {
    const use = identity();
    const accountId = await signIn(address());
    const answers = await Promise.all(Array.from({ length: 8 }, () => use.claimFirstOpen({ accountId })));
    expect(answers.filter((answer) => answer.claimed)).toHaveLength(1);
  });

  it('is one account’s own: another account still has its opening', async () => {
    const use = identity();
    const first = await signIn(address());
    const second = await signIn(address());
    expect((await use.claimFirstOpen({ accountId: first })).claimed).toBe(true);
    expect((await use.claimFirstOpen({ accountId: second })).claimed).toBe(true);
  });

  it('is not claimed by a suspended account or one that does not exist', async () => {
    const use = identity();
    const accountId = await signIn(address());
    await sql`update identity.accounts set status = 'suspended' where id = ${accountId}::uuid`.execute(database.db);
    expect(await use.claimFirstOpen({ accountId })).toEqual({ claimed: false });
    expect(await use.claimFirstOpen({ accountId: randomUUID() })).toEqual({ claimed: false });
    const row = await database.db
      .selectFrom('identity.accounts')
      .select('universe_first_opened_at')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(row.universe_first_opened_at).toBeNull();
  });

  it('writes nothing but the flag on the account row', async () => {
    const use = identity();
    const accountId = await signIn(address());
    const count = async (table: string) =>
      Number(
        (await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(database.db)).rows[0]!.n,
      );
    const tables = ['identity.universes', 'identity.sessions', 'identity.email_addresses', 'identity.clear_operations'];
    const before = await Promise.all(tables.map(count));
    await use.claimFirstOpen({ accountId });
    expect(await Promise.all(tables.map(count))).toEqual(before);
    const universe = await database.db
      .selectFrom('identity.universes')
      .select(['revision', 'privacy_epoch'])
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(universe).toEqual({ revision: 0, privacy_epoch: 1 });
  });
});
