import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import { ScopeNoticeRelay } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import type { MailDelivery, RedeemSignInResult } from '@knowscroll/backend/modules/identity';
import { identityUseCases, operatorSignInUseCase } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * Identity's sign-in use cases against a real PostgreSQL 16 database (S1.3 #226, D-018), built
 * from the same factories as the API's composition root. Mail goes to an in-test fixture sender;
 * every address is a fixture under `.test`. Evidence label: CI fixture + real database.
 */
const silent: LogEvent = () => undefined;
const origin = 'https://app.ci.invalid';

interface Outbox {
  readonly sent: { readonly to: string; readonly link: string }[];
  readonly send: (mail: { readonly to: string; readonly link: string }) => Promise<MailDelivery>;
}

function outbox(): Outbox {
  const sent: { readonly to: string; readonly link: string }[] = [];
  return {
    sent,
    send: (mail) => {
      sent.push(mail);
      return Promise.resolve({ kind: 'sent' });
    },
  };
}

function settings(overrides: Partial<IdentitySettings> = {}): IdentitySettings {
  return {
    publicOrigin: origin,
    secureCookies: true,
    mail: { sender: 'fixture', outboxFile: undefined },
    operatorSignIn: false,
    ...overrides,
  };
}

function tokenOf(link: string): string {
  const token = new URL(link).hash.replace(/^#token=/, '');
  expect(token).toMatch(/^ksl_[A-Za-z0-9_-]{43}$/);
  return token;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
let addressCounter = 0;
const freshAddress = () => `person-${Date.now()}-${(addressCounter += 1)}@identity.test`;

describe('sign-in, sessions and operator links (real database)', () => {
  let database: TestDatabase<Database>;
  let mail: Outbox;
  let identity: ReturnType<typeof identityUseCases>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('identity');
    mail = outbox();
    identity = identityUseCases({
      db: database.db,
      settings: settings(),
      lockTimeoutMs: 5_000,
      logEvent: silent,
      mailSender: mail.send,
    });
  });
  afterAll(async () => {
    await database.drop();
  });

  const count = async (table: 'identity.accounts' | 'identity.universes' | 'identity.email_addresses') =>
    Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(database.db)).rows[0]?.n);

  /** Requests a link for `address` and returns its token from the fixture outbox. */
  async function linkFor(address: string): Promise<string> {
    const before = mail.sent.length;
    const result = await identity.requestSignIn({ email: address });
    expect(result.kind).toBe('requested');
    if (result.kind === 'requested') expect(await result.delivery).toEqual({ kind: 'sent' });
    expect(mail.sent).toHaveLength(before + 1);
    const sent = mail.sent.at(-1);
    expect(sent?.to).toBe(address.trim().toLowerCase());
    return tokenOf(sent?.link ?? '');
  }

  function signedIn(result: RedeemSignInResult) {
    if (result.kind !== 'signed_in') throw new Error(`expected a sign-in, got ${result.reason}`);
    return result;
  }

  it('stores only the hash of a link, sends one mail, and creates no account for an unredeemed address', async () => {
    const address = freshAddress();
    const accountsBefore = await count('identity.accounts');
    const token = await linkFor(`  ${address.toUpperCase()} `);
    const rows = await database.db
      .selectFrom('identity.sign_in_links')
      .select([
        'token_hash',
        'address',
        'origin',
        sql<number>`extract(epoch from expires_at - created_at)::int`.as('ttl'),
      ])
      .where('address', '=', address)
      .execute();
    expect(rows).toEqual([{ token_hash: sha256(token), address, origin: 'email', ttl: 900 }]);
    const stored = JSON.stringify(
      await sql`select * from identity.sign_in_links where address = ${address}`.execute(database.db),
    );
    expect(stored).not.toContain(token);
    expect(await count('identity.accounts')).toBe(accountsBefore);
    expect(mail.sent.at(-1)?.link.startsWith(`${origin}/redeem#token=`)).toBe(true);
  });

  it('refuses a malformed address and limits one address to three links per fifteen minutes', async () => {
    expect(await identity.requestSignIn({ email: 'not an address' })).toEqual({
      kind: 'refused',
      reason: 'invalid_address',
    });
    const address = freshAddress();
    for (let index = 0; index < 3; index += 1) await linkFor(address);
    const sentBefore = mail.sent.length;
    const limited = await identity.requestSignIn({ email: address });
    expect(limited).toMatchObject({ kind: 'rate_limited' });
    if (limited.kind === 'rate_limited') {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(900);
    }
    expect(mail.sent).toHaveLength(sentBefore);
    const links = await database.db
      .selectFrom('identity.sign_in_links')
      .select('token_hash')
      .where('address', '=', address)
      .execute();
    expect(links).toHaveLength(3);
  });

  it('creates the account, its address and one universe root at epoch 1 with a receipt, in the redemption', async () => {
    const address = freshAddress();
    const token = await linkFor(address);
    const commandId = randomUUID();
    const result = signedIn(await identity.redeemSignIn({ token, commandId, client: 'web' }));
    expect(result).toMatchObject({ replayed: false, privacyEpoch: 1, origin: 'email' });
    expect(result.outcome.accountCreated).toBe(true);
    expect(result.session.token).toMatch(/^kss_[A-Za-z0-9_-]{43}$/);
    const universe = await database.db
      .selectFrom('identity.universes')
      .innerJoin('identity.email_addresses', 'identity.email_addresses.account_id', 'identity.universes.account_id')
      .select(['identity.universes.id', 'identity.universes.privacy_epoch', 'identity.email_addresses.disposable'])
      .where('identity.email_addresses.address', '=', address)
      .execute();
    expect(universe).toEqual([{ id: result.outcome.universeId, privacy_epoch: 1, disposable: false }]);
    const receipt = await database.db
      .selectFrom('receipts.personal_commands')
      .select(['operation', 'outcome', 'privacy_epoch'])
      .where('universe_id', '=', result.outcome.universeId)
      .where('command_id', '=', commandId)
      .executeTakeFirst();
    expect(receipt).toEqual({
      operation: 'identity.redeem-sign-in',
      outcome: { accountId: result.outcome.accountId, universeId: result.outcome.universeId, accountCreated: true },
      privacy_epoch: 1,
    });
    const session = await database.db
      .selectFrom('identity.sessions')
      .select(['token_hash', 'client', sql<number>`extract(epoch from expires_at - created_at)::int`.as('ttl')])
      .where('id', '=', result.session.id)
      .executeTakeFirst();
    expect(session).toEqual({ token_hash: sha256(result.session.token), client: 'web', ttl: 30 * 86_400 });

    // A later link for the same address signs into the same account.
    const again = signedIn(
      await identity.redeemSignIn({ token: await linkFor(address), commandId: randomUUID(), client: 'native' }),
    );
    expect(again.outcome).toEqual({ ...result.outcome, accountCreated: false });
  });

  it('consumes a link once: another command is refused, the same command replays with a fresh session', async () => {
    const token = await linkFor(freshAddress());
    const commandId = randomUUID();
    const first = signedIn(await identity.redeemSignIn({ token, commandId, client: 'native' }));
    expect(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'native' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
    const replay = signedIn(await identity.redeemSignIn({ token, commandId, client: 'native' }));
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toEqual(first.outcome);
    expect(replay.session.token).not.toBe(first.session.token);
    // The same command ID with another client is a different request.
    expect(await identity.redeemSignIn({ token, commandId, client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    // An unknown token looks exactly like a used one.
    expect(
      await identity.redeemSignIn({ token: `ksl_${'A'.repeat(43)}`, commandId: randomUUID(), client: 'web' }),
    ).toEqual({ kind: 'refused', reason: 'link_invalid' });
  });

  it('creates exactly one account and universe under concurrent retries of one redemption', async () => {
    const address = freshAddress();
    const token = await linkFor(address);
    const commandId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => identity.redeemSignIn({ token, commandId, client: 'native' })),
    );
    const accounts = new Set(results.map((result) => signedIn(result).outcome.accountId));
    expect(accounts.size).toBe(1);
    expect(results.filter((result) => signedIn(result).replayed)).toHaveLength(5);
    const rows = await database.db
      .selectFrom('identity.email_addresses')
      .innerJoin('identity.universes', 'identity.universes.account_id', 'identity.email_addresses.account_id')
      .select('identity.universes.id')
      .where('address', '=', address)
      .execute();
    expect(rows).toHaveLength(1);
    const receipts = await database.db
      .selectFrom('receipts.personal_commands')
      .select('command_id')
      .where('universe_id', '=', rows[0]?.id ?? '')
      .where('operation', '=', 'identity.redeem-sign-in')
      .execute();
    expect(receipts).toHaveLength(1);
  });

  it('creates one account when two links for one new address are redeemed at once', async () => {
    const address = freshAddress();
    const [first, second] = [await linkFor(address), await linkFor(address)];
    const results = await Promise.all([
      identity.redeemSignIn({ token: first, commandId: randomUUID(), client: 'web' }),
      identity.redeemSignIn({ token: second, commandId: randomUUID(), client: 'web' }),
    ]);
    const outcomes = results.map((result) => signedIn(result).outcome);
    expect(new Set(outcomes.map((outcome) => outcome.accountId)).size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.accountCreated)).toHaveLength(1);
    expect(
      await database.db
        .selectFrom('identity.email_addresses')
        .select('account_id')
        .where('address', '=', address)
        .execute(),
    ).toHaveLength(1);
  });

  it('lets only one of several different commands redeem one link at once', async () => {
    const token = await linkFor(freshAddress());
    const results = await Promise.all(
      Array.from({ length: 4 }, () => identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })),
    );
    expect(results.filter((result) => result.kind === 'signed_in')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'refused' && result.reason === 'link_invalid')).toHaveLength(3);
  });

  it('refuses an expired link, and the database refuses a link that would live longer than fifteen minutes', async () => {
    const address = freshAddress();
    const token = await linkFor(address);
    await database.db
      .updateTable('identity.sign_in_links')
      .set({
        created_at: sql`now() - interval '16 minutes'`,
        expires_at: sql`now() - interval '1 minute'`,
      })
      .where('token_hash', '=', sha256(token))
      .execute();
    expect(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
    await expect(
      database.db
        .insertInto('identity.sign_in_links')
        .values({
          token_hash: sha256(`ksl_${randomUUID()}`),
          address,
          origin: 'email',
          expires_at: sql`now() + interval '16 minutes'`,
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rolls everything back when the account is suspended: the link stays unconsumed', async () => {
    const address = freshAddress();
    const first = signedIn(
      await identity.redeemSignIn({ token: await linkFor(address), commandId: randomUUID(), client: 'web' }),
    );
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'suspended' })
      .where('id', '=', first.outcome.accountId)
      .execute();
    const token = await linkFor(address);
    expect(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'account_unavailable',
    });
    const link = await database.db
      .selectFrom('identity.sign_in_links')
      .select(['consumed_at', 'consumed_command_id'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    expect(link).toEqual({ consumed_at: null, consumed_command_id: null });
    // Sessions of a suspended account no longer resolve.
    expect(await identity.resolveSession(first.session.token)).toBeUndefined();
    await database.db
      .updateTable('identity.accounts')
      .set({ status: 'active' })
      .where('id', '=', first.outcome.accountId)
      .execute();
    expect((await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })).kind).toBe('signed_in');
  });

  it('resolves a session to its account, universe and current epoch, and refuses revoked and expired ones', async () => {
    const result = signedIn(
      await identity.redeemSignIn({ token: await linkFor(freshAddress()), commandId: randomUUID(), client: 'native' }),
    );
    const session = await identity.resolveSession(result.session.token);
    expect(session).toMatchObject({
      sessionId: result.session.id,
      accountId: result.outcome.accountId,
      universeId: result.outcome.universeId,
      privacyEpoch: 1,
      client: 'native',
    });
    // The epoch is re-read on every request, never remembered from sign-in.
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', result.outcome.universeId)
      .execute();
    expect((await identity.resolveSession(result.session.token))?.privacyEpoch).toBe(2);
    expect(await identity.resolveSession(`kss_${'B'.repeat(43)}`)).toBeUndefined();

    const relayed: string[] = [];
    const relay = new ScopeNoticeRelay({
      database: database.settings,
      sink: { onNotice: () => undefined, onResync: () => undefined, onAccessRevoked: (id) => relayed.push(id) },
      logEvent: silent,
    });
    await relay.start();
    try {
      expect(
        await identity.signOut({
          sessionId: result.session.id,
          accountId: result.outcome.accountId,
          everywhere: false,
        }),
      ).toEqual({ revoked: 1 });
      await expect.poll(() => relayed, { timeout: 10_000 }).toEqual([result.outcome.accountId]);
    } finally {
      await relay.stop();
    }
    expect(await identity.resolveSession(result.session.token)).toBeUndefined();
    expect(await identity.sessionValid({ sessionId: result.session.id, accountId: result.outcome.accountId })).toBe(
      false,
    );
    // Signing out again changes nothing.
    expect(
      await identity.signOut({ sessionId: result.session.id, accountId: result.outcome.accountId, everywhere: false }),
    ).toEqual({ revoked: 0 });

    const other = signedIn(
      await identity.redeemSignIn({ token: await linkFor(freshAddress()), commandId: randomUUID(), client: 'web' }),
    );
    await database.db
      .updateTable('identity.sessions')
      .set({ created_at: sql`now() - interval '31 days'`, expires_at: sql`now() - interval '1 day'` })
      .where('id', '=', other.session.id)
      .execute();
    expect(await identity.resolveSession(other.session.token)).toBeUndefined();
    expect(await identity.sessionValid({ sessionId: other.session.id, accountId: other.outcome.accountId })).toBe(
      false,
    );
  });

  it('signs out everywhere: every session of the account ends', async () => {
    const address = freshAddress();
    const sessions = [];
    for (const client of ['web', 'native', 'native'] as const)
      sessions.push(
        signedIn(await identity.redeemSignIn({ token: await linkFor(address), commandId: randomUUID(), client })),
      );
    const [first] = sessions;
    if (first === undefined) throw new Error('no session');
    expect(
      await identity.signOut({ sessionId: first.session.id, accountId: first.outcome.accountId, everywhere: true }),
    ).toEqual({ revoked: 3 });
    for (const session of sessions) expect(await identity.resolveSession(session.session.token)).toBeUndefined();
  });

  it('issues operator links only for disposable accounts, and redeems them only where operator sign-in is on', async () => {
    const issue = operatorSignInUseCase({ db: database.db, publicOrigin: origin, lockTimeoutMs: 5_000 });
    const address = freshAddress();
    const issued = await issue({ email: address });
    if (issued.kind !== 'issued') throw new Error(`operator issue refused: ${issued.reason}`);
    expect(issued.outcome.accountCreated).toBe(true);
    const token = tokenOf(issued.link);
    const stored = await database.db
      .selectFrom('identity.sign_in_links')
      .select(['origin', 'address'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    expect(stored).toEqual({ origin: 'operator', address });
    const receipt = await database.db
      .selectFrom('receipts.personal_commands')
      .select('operation')
      .where('universe_id', '=', issued.outcome.universeId)
      .execute();
    expect(receipt).toEqual([{ operation: 'identity.issue-operator-sign-in' }]);

    // An API without operator sign-in refuses the operator link like any unusable link.
    expect(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
    const operatorWorld = identityUseCases({
      db: database.db,
      settings: settings({ operatorSignIn: true }),
      lockTimeoutMs: 5_000,
      logEvent: silent,
      mailSender: mail.send,
    });
    const signed = signedIn(await operatorWorld.redeemSignIn({ token, commandId: randomUUID(), client: 'web' }));
    expect(signed).toMatchObject({
      origin: 'operator',
      outcome: { accountId: issued.outcome.accountId, accountCreated: false },
    });

    // A second issue finds the same disposable account.
    const second = await issue({ email: address });
    expect(second).toMatchObject({
      kind: 'issued',
      outcome: { accountId: issued.outcome.accountId, accountCreated: false },
    });

    // An account that signed up by mail is never opened by an operator link.
    const real = freshAddress();
    signedIn(await identity.redeemSignIn({ token: await linkFor(real), commandId: randomUUID(), client: 'web' }));
    const linksBefore = await database.db
      .selectFrom('identity.sign_in_links')
      .select('token_hash')
      .where('address', '=', real)
      .execute();
    expect(await issue({ email: real })).toEqual({ kind: 'refused', reason: 'not_disposable' });
    expect(
      await database.db.selectFrom('identity.sign_in_links').select('token_hash').where('address', '=', real).execute(),
    ).toHaveLength(linksBefore.length);
  });
});
