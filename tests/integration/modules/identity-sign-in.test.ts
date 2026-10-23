import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { ScopeNoticeRelay } from '@knowscroll/backend/infrastructure/notices';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import type { MailDelivery, RedeemSignInResult } from '@knowscroll/backend/modules/identity';
import {
  identitySweepUseCase,
  identityUseCases,
  operatorSignInUseCase,
} from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * Identity's sign-in use cases against a real PostgreSQL 16 database (S1.3 #226, D-022), built
 * from the same factories as the API's composition root. Mail goes to an in-test fixture sender;
 * every address is a fixture under `.test`. Evidence label: CI fixture + real database.
 */
const silent: LogEvent = () => undefined;
const origin = 'https://app.ci.invalid';
const operatorPattern = '*@operator.test';

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
    operatorSignIn: undefined,
    // On for these tests (native redemptions); the default on every world is off (re-review N1).
    nativeSignInBinding: true,
    ...overrides,
  };
}

function tokenOf(link: string): string {
  const token = new URL(link).hash.replace(/^#token=/, '');
  expect(token).toMatch(/^ksl_[A-Za-z0-9_-]{43}$/);
  return token;
}

/** A native app's binding (review m10): a verifier it keeps, and the S256 challenge it asks with. */
interface Device {
  readonly verifier: string;
  readonly challenge: string;
}

function device(): Device {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url') };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
let addressCounter = 0;
const freshAddress = (domain = 'identity.test') => `person-${Date.now()}-${(addressCounter += 1)}@${domain}`;

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

  /** Requests a link for `address` (bound to `bound` when given) and returns its token from the outbox. */
  async function linkFor(address: string, bound?: Device, use = identity): Promise<string> {
    const before = mail.sent.length;
    const result = await use.requestSignIn({
      email: address,
      ...(bound === undefined ? {} : { codeChallenge: bound.challenge }),
    });
    expect(result.kind).toBe('requested');
    if (result.kind === 'requested') expect(await result.delivery).toEqual({ kind: 'sent' });
    expect(mail.sent).toHaveLength(before + 1);
    const sent = mail.sent.at(-1);
    expect(sent?.to).toBe(address.trim().toLowerCase());
    return tokenOf(sent?.link ?? '');
  }

  /** A native redemption of a link asked for by `bound`. */
  const redeemNative = (token: string, commandId: string, bound: Device) =>
    identity.redeemSignIn({ token, commandId, client: 'native', codeVerifier: bound.verifier });

  function signedIn(result: RedeemSignInResult) {
    if (result.kind !== 'signed_in') throw new Error(`expected a sign-in, got ${result.reason}`);
    return result;
  }

  async function linkRow(token: string) {
    return database.db
      .selectFrom('identity.sign_in_links')
      .select(['consumed_at', 'consumed_command_id'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
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
        'domain',
        'origin',
        'code_challenge',
        sql<number>`extract(epoch from expires_at - created_at)::int`.as('ttl'),
      ])
      .where('address', '=', address)
      .execute();
    expect(rows).toEqual([
      { token_hash: sha256(token), address, domain: 'identity.test', origin: 'email', code_challenge: null, ttl: 900 },
    ]);
    const stored = JSON.stringify(
      await sql`select * from identity.sign_in_links where address = ${address}`.execute(database.db),
    );
    expect(stored).not.toContain(token);
    expect(await count('identity.accounts')).toBe(accountsBefore);
    expect(mail.sent.at(-1)?.link.startsWith(`${origin}/redeem#token=`)).toBe(true);
  });

  it('refuses addresses outside the RFC 5321 subset, a NUL included, without a database error (review m4)', async () => {
    const sentBefore = mail.sent.length;
    for (const email of [
      'not an address',
      'x<attacker@evil.test>',
      'a,b@evil.test',
      '"a";b@evil.test',
      'nul\u0000@identity.test',
      'zw​@identity.test',
      'nel\u0085@identity.test',
      'kelvinK@identity.test',
      'a@b',
      `${'a'.repeat(65)}@identity.test`,
    ])
      expect(await identity.requestSignIn({ email }), JSON.stringify(email)).toEqual({
        kind: 'refused',
        reason: 'invalid_address',
      });
    expect(mail.sent).toHaveLength(sentBefore);
  });

  it('limits one address to three links per fifteen minutes', async () => {
    const address = freshAddress();
    for (let index = 0; index < 3; index += 1) await linkFor(address);
    const sentBefore = mail.sent.length;
    const limited = await identity.requestSignIn({ email: address });
    expect(limited).toMatchObject({ kind: 'rate_limited', budget: 'address' });
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
    expect(
      await database.db
        .selectFrom('identity.recording_lifecycle_witnesses')
        .select(['account_id', 'privacy_epoch', 'origin_kind', 'clear_operation_id'])
        .where('universe_id', '=', result.outcome.universeId)
        .execute(),
    ).toEqual([
      { account_id: result.outcome.accountId, privacy_epoch: 1, origin_kind: 'birth', clear_operation_id: null },
    ]);

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
      .select([
        'token_hash',
        'client',
        'issued_by_command',
        sql<number>`extract(epoch from expires_at - created_at)::int`.as('ttl'),
      ])
      .where('id', '=', result.session.id)
      .executeTakeFirst();
    expect(session).toEqual({
      token_hash: sha256(result.session.token),
      client: 'web',
      issued_by_command: commandId,
      ttl: 30 * 86_400,
    });

    // A later link for the same address, from a native app, signs into the same account.
    const phone = device();
    const again = signedIn(await redeemNative(await linkFor(address, phone), randomUUID(), phone));
    expect(again.outcome).toEqual({ ...result.outcome, accountCreated: false });
  });

  it('consumes a link once: another command is refused, the same command replays and replaces its session', async () => {
    const phone = device();
    const token = await linkFor(freshAddress(), phone);
    const commandId = randomUUID();
    const first = signedIn(await redeemNative(token, commandId, phone));
    expect(await redeemNative(token, randomUUID(), phone)).toEqual({ kind: 'refused', reason: 'link_invalid' });
    const replay = signedIn(await redeemNative(token, commandId, phone));
    expect(replay.replayed).toBe(true);
    expect(replay.outcome).toEqual(first.outcome);
    expect(replay.session.token).not.toBe(first.session.token);
    // The replaced session ends: a replay never leaves two live sessions behind.
    expect(await identity.resolveSession(first.session.token)).toBeUndefined();
    expect((await identity.resolveSession(replay.session.token))?.sessionId).toBe(replay.session.id);
    const revoked = await database.db
      .selectFrom('identity.sessions')
      .select('revoked_reason')
      .where('id', '=', first.session.id)
      .executeTakeFirst();
    // Ended sessions are removed when the account gets a new one; either way it is not live.
    expect(revoked === undefined || revoked.revoked_reason === 'replaced').toBe(true);
    // The same command ID with another client is a different request.
    expect(await identity.redeemSignIn({ token, commandId, client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
    // An unknown token looks exactly like a used one.
    expect(
      await identity.redeemSignIn({ token: `ksl_${'A'.repeat(43)}`, commandId: randomUUID(), client: 'web' }),
    ).toEqual({ kind: 'refused', reason: 'link_invalid' });
  });

  it('never revives a signed-out session by replaying its redemption (review m5)', async () => {
    const token = await linkFor(freshAddress());
    const commandId = randomUUID();
    const first = signedIn(await identity.redeemSignIn({ token, commandId, client: 'web' }));
    expect(
      await identity.signOut({ sessionId: first.session.id, accountId: first.outcome.accountId, everywhere: true }),
    ).toEqual({ revoked: 1 });
    const sessionsBefore = await database.db
      .selectFrom('identity.sessions')
      .select('id')
      .where('account_id', '=', first.outcome.accountId)
      .execute();
    expect(await identity.redeemSignIn({ token, commandId, client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
    expect(
      await database.db
        .selectFrom('identity.sessions')
        .select('id')
        .where('account_id', '=', first.outcome.accountId)
        .execute(),
    ).toEqual(sessionsBefore);
  });

  it('a refused redemption consumes nothing: a reused command ID leaves the link usable (review m1)', async () => {
    const address = freshAddress();
    const commandId = randomUUID();
    signedIn(await identity.redeemSignIn({ token: await linkFor(address), commandId, client: 'web' }));
    // A second link for the same account, redeemed under the first redemption's command ID.
    const token = await linkFor(address);
    expect(await identity.redeemSignIn({ token, commandId, client: 'web' })).toEqual({
      kind: 'refused',
      reason: 'command_key_reused',
    });
    expect(await linkRow(token)).toEqual({ consumed_at: null, consumed_command_id: null });
    const later = signedIn(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' }));
    expect(later.outcome.accountCreated).toBe(false);
  });

  it('binds a native link to its device: only the verifier of its challenge redeems it (review m10)', async () => {
    const phone = device();
    const address = freshAddress();
    const token = await linkFor(address, phone);
    const stored = await database.db
      .selectFrom('identity.sign_in_links')
      .select('code_challenge')
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    expect(stored).toEqual({ code_challenge: phone.challenge });
    // Intercepted: another device's verifier, no verifier, or the web.
    for (const attempt of [
      { client: 'native' as const, codeVerifier: device().verifier },
      { client: 'native' as const },
      { client: 'web' as const },
    ])
      expect(await identity.redeemSignIn({ token, commandId: randomUUID(), ...attempt })).toEqual({
        kind: 'refused',
        reason: 'link_invalid',
      });
    expect(await linkRow(token)).toEqual({ consumed_at: null, consumed_command_id: null });
    // A native link answers only to its own verifier, and masked (re-review nit).
    expect(await identity.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'link_invalid' });
    expect(await identity.peekSignInLink({ token, client: 'native' })).toEqual({ kind: 'link_invalid' });
    expect(await identity.peekSignInLink({ token, client: 'native', codeVerifier: device().verifier })).toEqual({
      kind: 'link_invalid',
    });
    expect(await identity.peekSignInLink({ token, client: 'native', codeVerifier: phone.verifier })).toEqual({
      kind: 'usable',
      email: 'p•••@identity.test',
    });
    signedIn(await redeemNative(token, randomUUID(), phone));

    // A link asked for without a challenge (the web's) is never redeemed by a native client.
    const webToken = await linkFor(address);
    expect(await identity.redeemSignIn({ token: webToken, commandId: randomUUID(), client: 'native' })).toEqual({
      kind: 'refused',
      reason: 'link_invalid',
    });
  });

  it('peeks at a web link without consuming it, showing the full address (review m8, re-review N6)', async () => {
    const address = freshAddress();
    const token = await linkFor(address);
    expect(await identity.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'usable', email: address });
    expect(await linkRow(token)).toEqual({ consumed_at: null, consumed_command_id: null });
    signedIn(await identity.redeemSignIn({ token, commandId: randomUUID(), client: 'web' }));
    expect(await identity.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'link_invalid' });
    expect(await identity.peekSignInLink({ token: `ksl_${'C'.repeat(43)}`, client: 'web' })).toEqual({
      kind: 'link_invalid',
    });
  });

  it('creates exactly one account and universe under concurrent retries of one redemption', async () => {
    const address = freshAddress();
    const phone = device();
    const token = await linkFor(address, phone);
    const commandId = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => redeemNative(token, commandId, phone)));
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
    // Each replay replaced the previous one's session: one live session for the command.
    const live = await database.db
      .selectFrom('identity.sessions')
      .select('id')
      .where('issued_by_command', '=', commandId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(live).toHaveLength(1);
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
    expect(await identity.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'link_invalid' });
    await expect(
      database.db
        .insertInto('identity.sign_in_links')
        .values({
          token_hash: sha256(`ksl_${randomUUID()}`),
          address,
          domain: 'identity.test',
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
    expect(await linkRow(token)).toEqual({ consumed_at: null, consumed_command_id: null });
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
    const phone = device();
    const result = signedIn(await redeemNative(await linkFor(freshAddress(), phone), randomUUID(), phone));
    const session = await identity.resolveSession(result.session.token);
    expect(result.address).toMatch(/@identity\.test$/);
    expect(session).toMatchObject({
      sessionId: result.session.id,
      accountId: result.outcome.accountId,
      address: result.address,
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
    // A suspended universe ends its sessions' validity too.
    await database.db
      .updateTable('identity.universes')
      .set({ status: 'suspended' })
      .where('id', '=', result.outcome.universeId)
      .execute();
    expect(await identity.sessionValid({ sessionId: result.session.id, accountId: result.outcome.accountId })).toBe(
      false,
    );
    await database.db
      .updateTable('identity.universes')
      .set({ status: 'active' })
      .where('id', '=', result.outcome.universeId)
      .execute();

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
    sessions.push(
      signedIn(await identity.redeemSignIn({ token: await linkFor(address), commandId: randomUUID(), client: 'web' })),
    );
    for (let index = 0; index < 2; index += 1) {
      const phone = device();
      sessions.push(signedIn(await redeemNative(await linkFor(address, phone), randomUUID(), phone)));
    }
    const [first] = sessions;
    if (first === undefined) throw new Error('no session');
    expect(
      await identity.signOut({ sessionId: first.session.id, accountId: first.outcome.accountId, everywhere: true }),
    ).toEqual({ revoked: 3 });
    for (const session of sessions) expect(await identity.resolveSession(session.session.token)).toBeUndefined();
  });

  it('refuses native challenges while binding is off, so nobody can lock an address out with them (re-review N1, probe p15)', async () => {
    const off = identityUseCases({
      db: database.db,
      settings: settings({ nativeSignInBinding: false }),
      lockTimeoutMs: 5_000,
      logEvent: silent,
      mailSender: mail.send,
    });
    const victim = freshAddress();
    const sentBefore = mail.sent.length;
    // The attacker asks three links for the victim, each bound to a challenge only it holds.
    for (let index = 0; index < 3; index += 1)
      expect(await off.requestSignIn({ email: victim, codeChallenge: device().challenge })).toEqual({
        kind: 'refused',
        reason: 'binding_not_enabled',
      });
    expect(mail.sent).toHaveLength(sentBefore);
    expect(
      await database.db
        .selectFrom('identity.sign_in_links')
        .select('token_hash')
        .where('address', '=', victim)
        .execute(),
    ).toEqual([]);
    // The victim's own request still gets a link, and it works on the web.
    const token = await linkFor(victim, undefined, off);
    expect(await off.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'usable', email: victim });
    signedIn(await off.redeemSignIn({ token, commandId: randomUUID(), client: 'web' }));
  });

  it('issues operator links only for the world pattern and disposable accounts, audited, and checks the pattern again at redemption (review m2, m9)', async () => {
    const issue = operatorSignInUseCase({
      db: database.db,
      publicOrigin: origin,
      lockTimeoutMs: 5_000,
      pattern: operatorPattern,
      world: 'ci',
      operatorSource: 'cli:ci-runner',
    });
    // Outside the pattern: never issued, nothing written.
    const outside = freshAddress();
    expect(await issue({ email: outside })).toEqual({ kind: 'refused', reason: 'address_not_allowed' });
    expect(await issue({ email: 'x<attacker@operator.test>' })).toEqual({ kind: 'refused', reason: 'invalid_address' });
    expect(
      await database.db
        .selectFrom('identity.email_addresses')
        .select('account_id')
        .where('address', '=', outside)
        .execute(),
    ).toEqual([]);

    const address = freshAddress('operator.test');
    const issued = await issue({ email: address });
    if (issued.kind !== 'issued') throw new Error(`operator issue refused: ${issued.reason}`);
    expect(issued.outcome.accountCreated).toBe(true);
    const token = tokenOf(issued.link);
    const stored = await database.db
      .selectFrom('identity.sign_in_links')
      .select(['origin', 'address', 'domain'])
      .where('token_hash', '=', sha256(token))
      .executeTakeFirst();
    expect(stored).toEqual({ origin: 'operator', address, domain: 'operator.test' });
    const receipt = await database.db
      .selectFrom('receipts.personal_commands')
      .select('operation')
      .where('universe_id', '=', issued.outcome.universeId)
      .execute();
    expect(receipt).toEqual([{ operation: 'identity.issue-operator-sign-in' }]);
    const audit = await database.db
      .selectFrom('ops.operator_sign_ins')
      .select(['world', 'operator_source', 'account_id', 'account_created'])
      .where('account_id', '=', issued.outcome.accountId)
      .execute();
    expect(audit).toEqual([
      { world: 'ci', operator_source: 'cli:ci-runner', account_id: issued.outcome.accountId, account_created: true },
    ]);

    // An API without operator sign-in, or with another pattern, refuses the link like any unusable one.
    const elsewhere = identityUseCases({
      db: database.db,
      settings: settings({ operatorSignIn: { pattern: '*@other.test' } }),
      lockTimeoutMs: 5_000,
      logEvent: silent,
      mailSender: mail.send,
    });
    for (const api of [identity, elsewhere]) {
      expect(await api.peekSignInLink({ token, client: 'web' })).toEqual({ kind: 'link_invalid' });
      expect(await api.redeemSignIn({ token, commandId: randomUUID(), client: 'web' })).toEqual({
        kind: 'refused',
        reason: 'link_invalid',
      });
    }
    expect(await linkRow(token)).toEqual({ consumed_at: null, consumed_command_id: null });
    const operatorWorld = identityUseCases({
      db: database.db,
      settings: settings({ operatorSignIn: { pattern: operatorPattern } }),
      lockTimeoutMs: 5_000,
      logEvent: silent,
      mailSender: mail.send,
    });
    const signed = signedIn(await operatorWorld.redeemSignIn({ token, commandId: randomUUID(), client: 'web' }));
    expect(signed).toMatchObject({
      origin: 'operator',
      outcome: { accountId: issued.outcome.accountId, accountCreated: false },
    });

    // A second issue finds the same disposable account and is audited again.
    const second = await issue({ email: address });
    expect(second).toMatchObject({
      kind: 'issued',
      outcome: { accountId: issued.outcome.accountId, accountCreated: false },
    });

    // The audit survives clearing the universe's history; receipts do not.
    const withPersonalScope = makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
    await withPersonalScope(
      {
        universeId: issued.outcome.universeId,
        privacyEpoch: 1,
        actor: { kind: 'account', accountId: issued.outcome.accountId },
      },
      (scope) => eraseUniverse(scope, personalStores),
    );
    expect(
      await database.db
        .selectFrom('receipts.personal_commands')
        .select('command_id')
        .where('universe_id', '=', issued.outcome.universeId)
        .execute(),
    ).toEqual([]);
    expect(
      await database.db
        .selectFrom('ops.operator_sign_ins')
        .select('account_created')
        .where('account_id', '=', issued.outcome.accountId)
        .orderBy('issued_at')
        .execute(),
    ).toEqual([{ account_created: true }, { account_created: false }]);

    // An account that signed up by mail, even under the pattern, is never opened by an operator link.
    const real = freshAddress('operator.test');
    signedIn(await identity.redeemSignIn({ token: await linkFor(real), commandId: randomUUID(), client: 'web' }));
    expect(await issue({ email: real })).toEqual({ kind: 'refused', reason: 'not_disposable' });

    // A disposable account whose address then proves itself by mail stops being disposable.
    const claimed = freshAddress('operator.test');
    expect((await issue({ email: claimed })).kind).toBe('issued');
    signedIn(await identity.redeemSignIn({ token: await linkFor(claimed), commandId: randomUUID(), client: 'web' }));
    expect(
      await database.db
        .selectFrom('identity.email_addresses')
        .select('disposable')
        .where('address', '=', claimed)
        .executeTakeFirst(),
    ).toEqual({ disposable: false });
    expect(await issue({ email: claimed })).toEqual({ kind: 'refused', reason: 'not_disposable' });
  });

  it('sweeps expired links and long-ended sessions, and keeps everything still in use (review m12)', async () => {
    const sweep = identitySweepUseCase(database.db);
    const address = freshAddress();
    const live = await linkFor(address);
    const old = sha256(`ksl_${randomUUID()}`);
    await database.db
      .insertInto('identity.sign_in_links')
      .values({
        token_hash: old,
        address,
        domain: 'identity.test',
        origin: 'email',
        created_at: sql`now() - interval '2 days'`,
        expires_at: sql`now() - interval '2 days' + interval '15 minutes'`,
      })
      .execute();
    const person = signedIn(
      await identity.redeemSignIn({ token: await linkFor(freshAddress()), commandId: randomUUID(), client: 'web' }),
    );
    const sessionAt = (id: string, created: string, expires: string, revoked?: string) =>
      database.db
        .insertInto('identity.sessions')
        .values({
          id,
          account_id: person.outcome.accountId,
          token_hash: sha256(id),
          client: 'web',
          created_at: sql`now() - ${created}::interval`,
          expires_at: sql`now() - ${expires}::interval`,
          ...(revoked === undefined
            ? {}
            : { revoked_at: sql`now() - ${revoked}::interval`, revoked_reason: 'signed_out' }),
        })
        .execute();
    const [longExpired, longRevoked, recentlyExpired] = [randomUUID(), randomUUID(), randomUUID()];
    await sessionAt(longExpired, '61 days', '31 days');
    await sessionAt(longRevoked, '40 days', '10 days', '31 days');
    await sessionAt(recentlyExpired, '31 days', '1 day');

    const removed = await sweep();
    expect(removed.links).toBeGreaterThanOrEqual(1);
    expect(removed.sessions).toBeGreaterThanOrEqual(2);
    const links = await database.db
      .selectFrom('identity.sign_in_links')
      .select('token_hash')
      .where('token_hash', 'in', [old, sha256(live)])
      .execute();
    expect(links).toEqual([{ token_hash: sha256(live) }]);
    const sessions = await database.db
      .selectFrom('identity.sessions')
      .select('id')
      .where('id', 'in', [longExpired, longRevoked, recentlyExpired, person.session.id])
      .orderBy('id')
      .execute();
    expect(sessions.map((row) => row.id).sort()).toEqual([recentlyExpired, person.session.id].sort());
    expect(await sweep()).toEqual({ links: 0, sessions: 0 });
  });

  it('spends the domain and world budgets only on links it issues, and alerts once when one fills (review M2)', async () => {
    const events: { readonly name: string; readonly fields: unknown }[] = [];
    const watched = identityUseCases({
      db: database.db,
      settings: settings(),
      lockTimeoutMs: 5_000,
      logEvent: (name: string, fields: unknown) => void events.push({ name, fields }),
      mailSender: mail.send,
    });
    const fill = async (rows: readonly { readonly address: string; readonly domain: string }[]) => {
      for (let start = 0; start < rows.length; start += 100)
        await database.db
          .insertInto('identity.sign_in_links')
          .values(
            rows.slice(start, start + 100).map((row) => ({
              token_hash: sha256(`ksl_${randomUUID()}`),
              address: row.address,
              domain: row.domain,
              origin: 'email',
              expires_at: sql<Date>`now() + interval '15 minutes'`,
            })),
          )
          .execute();
    };
    const alerts = () => events.filter((event) => event.name === 'identity.sign_in_budget_full');
    try {
      // One recipient domain: 60 links per 15 minutes.
      await fill(Array.from({ length: 60 }, (_, index) => ({ address: `f${index}@busy.test`, domain: 'busy.test' })));
      expect(await watched.requestSignIn({ email: freshAddress('busy.test') })).toMatchObject({
        kind: 'rate_limited',
        budget: 'domain',
      });
      expect(await watched.requestSignIn({ email: freshAddress('busy.test') })).toMatchObject({ budget: 'domain' });
      await linkFor(freshAddress('quiet.test'), undefined, watched);
      expect(alerts()).toEqual([{ name: 'identity.sign_in_budget_full', fields: { reasonCode: 'domain' } }]);

      // The world: 300 email links per 15 minutes. An address already at its own limit, then the
      // world filled to one below.
      const limitedAddress = freshAddress('limited.test');
      await fill(Array.from({ length: 3 }, () => ({ address: limitedAddress, domain: 'limited.test' })));
      const inWindow = await sql<{ n: number }>`
        select count(*)::int as n from identity.sign_in_links
        where origin = 'email' and created_at > now() - interval '15 minutes'`.execute(database.db);
      const filled = 299 - (inWindow.rows[0]?.n ?? 0);
      expect(filled).toBeGreaterThan(0);
      await fill(
        Array.from({ length: filled }, (_, index) => ({
          address: `w${index}@w${index}.test`,
          domain: `w${index}.test`,
        })),
      );
      // Malformed requests and requests for the limited address spend none of it.
      for (let index = 0; index < 25; index += 1)
        expect((await watched.requestSignIn({ email: `junk-${index}` })).kind).toBe('refused');
      for (let index = 0; index < 5; index += 1)
        expect(await watched.requestSignIn({ email: limitedAddress })).toMatchObject({ budget: 'address' });
      // So one more person still gets a link (the world's 300th), and the next one does not.
      const sentBefore = mail.sent.length;
      expect((await watched.requestSignIn({ email: freshAddress('fresh.test') })).kind).toBe('requested');
      const refused = await watched.requestSignIn({ email: freshAddress('fresh.test') });
      expect(refused).toMatchObject({ kind: 'rate_limited', budget: 'world' });
      if (refused.kind === 'rate_limited') {
        expect(refused.retryAfterSeconds).toBeGreaterThan(0);
        expect(refused.retryAfterSeconds).toBeLessThanOrEqual(900);
      }
      expect((await watched.requestSignIn({ email: freshAddress('fresh2.test') })).kind).toBe('rate_limited');
      await expect.poll(() => mail.sent.length).toBe(sentBefore + 1);
      expect(alerts()).toEqual([
        { name: 'identity.sign_in_budget_full', fields: { reasonCode: 'domain' } },
        { name: 'identity.sign_in_budget_full', fields: { reasonCode: 'world' } },
      ]);
    } finally {
      // Out of the window again, so nothing after this test is limited by the filler.
      await database.db
        .updateTable('identity.sign_in_links')
        .set({ created_at: sql`now() - interval '1 hour'`, expires_at: sql`now() - interval '45 minutes'` })
        .where('created_at', '>', sql<Date>`now() - interval '15 minutes'`)
        .execute();
    }
  });

  it('holds the domain budget exactly under concurrent requests for different addresses (re-review N4, probe p11)', async () => {
    const domain = `race-${Date.now()}.test`;
    const sentBefore = mail.sent.length;
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => identity.requestSignIn({ email: `u${index}@${domain}` })),
    );
    expect(results.filter((result) => result.kind === 'requested')).toHaveLength(60);
    expect(results.filter((result) => result.kind === 'rate_limited' && result.budget === 'domain')).toHaveLength(40);
    const links = await database.db
      .selectFrom('identity.sign_in_links')
      .select('token_hash')
      .where('domain', '=', domain)
      .execute();
    expect(links).toHaveLength(60);
    await expect.poll(() => mail.sent.length - sentBefore).toBe(60);
  });
});
