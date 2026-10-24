import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentitySettings } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { identityUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import { createTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * Session management (#246): Account lists a person's live sessions with a coarse device label,
 * signs one other session out, or all others. Evidence label: real sign-in through the identity
 * use cases against a real PostgreSQL 16 database, mail to an in-test sender, fixture addresses.
 */
const settings: IdentitySettings = {
  publicOrigin: 'https://app.ci.invalid',
  secureCookies: true,
  mail: { sender: 'fixture', outboxFile: undefined },
  operatorSignIn: undefined,
  nativeSignInBinding: false,
};

describe('listing and ending sessions (real database)', () => {
  let database: TestDatabase<Database>;
  const mail: { to: string; link: string }[] = [];

  beforeAll(async () => {
    database = await createTestDatabase<Database>('account_sessions');
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

  /** Signs `address` in on a new device; the first call creates the account. */
  async function signIn(address: string, deviceLabel?: string) {
    const use = identity();
    const requested = await use.requestSignIn({ email: address });
    if (requested.kind !== 'requested') throw new Error('not requested');
    await requested.delivery;
    const token = new URL(mail.at(-1)?.link ?? '').hash.replace(/^#token=/, '');
    const result = await use.redeemSignIn({
      token,
      commandId: randomUUID(),
      client: 'web',
      ...(deviceLabel === undefined ? {} : { deviceLabel }),
    });
    if (result.kind !== 'signed_in') throw new Error('refused');
    return { accountId: result.outcome.accountId, session: result.session };
  }

  const address = () => `sessions-${randomUUID()}@sessions.test`;

  it('lists live sessions newest use first, marks this one, and shows no secret', async () => {
    const use = identity();
    const who = address();
    const laptop = await signIn(who, 'Chrome on macOS');
    const phone = await signIn(who, 'Safari on iPhone');
    const unlabeled = await signIn(who);
    await sql`update identity.sessions set last_used_at = now() - interval '2 days' where id = ${laptop.session.id}::uuid`.execute(
      database.db,
    );
    await sql`update identity.sessions set last_used_at = now() - interval '1 hour' where id = ${phone.session.id}::uuid`.execute(
      database.db,
    );

    const listed = await use.listSessions({ accountId: laptop.accountId, sessionId: phone.session.id });
    expect(listed.map((entry) => [entry.deviceLabel, entry.current])).toEqual([
      ['Web browser', false],
      ['Safari on iPhone', true],
      ['Chrome on macOS', false],
    ]);
    expect(listed.map((entry) => entry.id)).toEqual([unlabeled.session.id, phone.session.id, laptop.session.id]);
    for (const entry of listed)
      expect(Object.keys(entry).sort()).toEqual(['client', 'current', 'deviceLabel', 'id', 'lastUsedAt', 'signedInAt']);
    expect(JSON.stringify(listed)).not.toContain('kss_');
    expect(listed.find((entry) => entry.id === laptop.session.id)?.lastUsedAt.getTime()).toBeLessThan(
      Date.now() - 86_400_000,
    );

    // Ended and expired sessions are not live sessions.
    await use.signOut({ sessionId: unlabeled.session.id, accountId: laptop.accountId, everywhere: false });
    await sql`update identity.sessions set created_at = now() - interval '3 days', expires_at = now() - interval '1 second' where id = ${laptop.session.id}::uuid`.execute(
      database.db,
    );
    expect(
      (await use.listSessions({ accountId: laptop.accountId, sessionId: phone.session.id })).map((entry) => entry.id),
    ).toEqual([phone.session.id]);
  });

  it('records use at most every ten minutes', async () => {
    const use = identity();
    const person = await signIn(address(), 'Firefox on Linux');
    const lastUsed = async () =>
      (
        await database.db
          .selectFrom('identity.sessions')
          .select('last_used_at')
          .where('id', '=', person.session.id)
          .executeTakeFirstOrThrow()
      ).last_used_at;
    await sql`update identity.sessions set last_used_at = now() - interval '11 minutes' where id = ${person.session.id}::uuid`.execute(
      database.db,
    );
    const stale = await lastUsed();
    expect(await use.resolveSession(person.session.token)).toMatchObject({ sessionId: person.session.id });
    const touched = await lastUsed();
    expect(touched?.getTime()).toBeGreaterThan(stale?.getTime() ?? 0);
    expect(Date.now() - (touched?.getTime() ?? 0)).toBeLessThan(60_000);
    // Soon afterwards another request is not a write.
    await use.resolveSession(person.session.token);
    expect((await lastUsed())?.getTime()).toBe(touched?.getTime());
  });

  it('signs another session out, never this one, and never another person’s', async () => {
    const use = identity();
    const who = address();
    const here = await signIn(who, 'Chrome on macOS');
    const there = await signIn(who, 'Safari on iPhone');
    const stranger = await signIn(address(), 'Chrome on Windows');

    expect(
      await use.endSession({
        accountId: here.accountId,
        currentSessionId: here.session.id,
        sessionId: here.session.id,
      }),
    ).toEqual({
      kind: 'current_session',
    });
    expect(await use.resolveSession(here.session.token)).toBeDefined();

    expect(
      await use.endSession({
        accountId: here.accountId,
        currentSessionId: here.session.id,
        sessionId: stranger.session.id,
      }),
    ).toEqual({
      kind: 'not_found',
    });
    expect(await use.resolveSession(stranger.session.token)).toBeDefined();
    expect(
      await use.endSession({ accountId: here.accountId, currentSessionId: here.session.id, sessionId: randomUUID() }),
    ).toEqual({
      kind: 'not_found',
    });

    expect(
      await use.endSession({
        accountId: here.accountId,
        currentSessionId: here.session.id,
        sessionId: there.session.id,
      }),
    ).toEqual({
      kind: 'ended',
    });
    expect(await use.resolveSession(there.session.token)).toBeUndefined();
    expect(await use.sessionValid({ sessionId: there.session.id, accountId: here.accountId })).toBe(false);
    // Ending it again is not found: it is no longer a live session.
    expect(
      await use.endSession({
        accountId: here.accountId,
        currentSessionId: here.session.id,
        sessionId: there.session.id,
      }),
    ).toEqual({
      kind: 'not_found',
    });
    expect(await use.resolveSession(here.session.token)).toBeDefined();
  });

  it('signs out every other session at once and keeps this one', async () => {
    const use = identity();
    const who = address();
    const here = await signIn(who, 'Chrome on macOS');
    const others = [await signIn(who, 'Safari on iPhone'), await signIn(who, 'Edge on Windows')];
    const stranger = await signIn(address());

    expect(await use.endOtherSessions({ accountId: here.accountId, currentSessionId: here.session.id })).toEqual({
      revoked: 2,
    });
    for (const other of others) expect(await use.resolveSession(other.session.token)).toBeUndefined();
    expect(await use.resolveSession(here.session.token)).toBeDefined();
    expect(await use.resolveSession(stranger.session.token)).toBeDefined();
    expect(
      (await use.listSessions({ accountId: here.accountId, sessionId: here.session.id })).map((entry) => entry.id),
    ).toEqual([here.session.id]);
    expect(await use.endOtherSessions({ accountId: here.accountId, currentSessionId: here.session.id })).toEqual({
      revoked: 0,
    });
  });
});
