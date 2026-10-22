/** Hosted Actions only. Authored accounts and real disposable PostgreSQL; no actual contacts. */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { gate } from '../support/fixture-model.js';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { socialUseCases } from '@knowscroll/backend/modules/social/nest-providers';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  createDatabase,
  transactionOf,
  makeWithPersonalScope,
  type Database,
} from '@knowscroll/backend/infrastructure/postgres';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
const version = 'sharing.v1' as const;
describe('revocable invitation lifecycle (synthetic PG accounts)', () => {
  let db: TestDatabase<Database>,
    now = Date.parse('2026-10-23T00:00:00Z');
  beforeAll(async () => {
    db = await createTestDatabase<Database>('social_invites');
  });
  afterAll(async () => {
    await db.drop();
  });
  const cases = () => {
    const access = accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 });
    return socialUseCases({
      withScope: makeWithPersonalScope(db.db, { lockTimeoutMs: 5000 }),
      fencePair: access.fenceAccountPair,
      fenceOwn: access.fenceOwnAccount,
      now: () => new Date(now),
    });
  };
  async function person() {
    const p = await seedPerson(db.db);
    const c = cases();
    await c.setProfile(p.authority, {
      version,
      commandId: randomUUID(),
      expectedProfileRevision: 0,
      handle: `ci.${p.accountId.replaceAll('-', '').slice(0, 16)}`,
      displayName: '友人',
    });
    const r = await c.readProfile(p.authority);
    if (r.kind !== 'ok' || r.value.status !== 'claimed') throw new Error('CI_PROFILE');
    return { ...p, person: r.value.person };
  }
  const create = (p: FixturePerson, revision = 0, commandId = randomUUID()) =>
    cases().createInvite(p.authority, { version, commandId, expectedInviteRevision: revision });
  it('delivers one secret once; stores only hash/acceptance; exact retry is delivery-unavailable', async () => {
    const a = await person(),
      id = randomUUID(),
      q = { version, commandId: id, expectedInviteRevision: 0 },
      c = cases();
    const both = await Promise.all([c.createInvite(a.authority, q), c.createInvite(a.authority, q)]);
    if (both.some((r) => r.kind !== 'ok')) throw new Error('CI_CREATE');
    const values = both.map((r) => {
      if (r.kind !== 'ok') throw new Error('CI_CREATE');
      return r.value;
    });
    expect(values.filter((r) => r.delivery.status === 'available')).toHaveLength(1);
    expect(values.filter((r) => r.acceptance.replayed)).toHaveLength(1);
    const first = values.find((r) => r.delivery.status === 'available')!;
    if (first.delivery.status !== 'available') throw new Error('CI_SECRET');
    const stored = await db.db
      .selectFrom('social.invites')
      .selectAll()
      .where('account_id', '=', a.accountId)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(first.delivery.token);
    expect(
      JSON.stringify(
        await db.db
          .selectFrom('receipts.personal_commands')
          .select('outcome')
          .where('universe_id', '=', a.universeId)
          .execute(),
      ),
    ).not.toContain(first.delivery.token);
    expect(await c.createInvite(a.authority, q)).toEqual({
      kind: 'ok',
      value: { acceptance: { ...first.acceptance, replayed: true }, delivery: { status: 'unavailable' } },
    });
    expect(await create(a, 1)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(await c.createInvite(a.authority, { ...q, expectedInviteRevision: 1 })).toEqual({
      kind: 'refused',
      code: 'command_key_reused',
    });
  });
  it('resolves and requests only the selected current issuer; revocation fences historical grant retries', async () => {
    const a = await person(),
      b = await person(),
      other = await person(),
      c = cases(),
      created = await create(a);
    if (created.kind !== 'ok' || created.value.delivery.status !== 'available') throw new Error('CI_CREATE');
    const token = created.value.delivery.token,
      link = created.value.acceptance.linkId;
    expect(await c.resolveInvite(b.authority, { version, token })).toMatchObject({
      kind: 'ok',
      value: { status: 'available', issuer: a.person, pairRevision: 0 },
    });
    const q = {
      version,
      commandId: randomUUID(),
      expectedPeerPersonId: a.person.personId,
      expectedPairRevision: 0,
      target: { kind: 'invite', token },
    };
    expect(await c.command(b.authority, 'request', { ...q, expectedPeerPersonId: other.person.personId })).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    expect((await c.command(b.authority, 'request', q)).kind).toBe('ok');
    const revoke = { version, commandId: randomUUID(), linkId: link, expectedInviteRevision: 1 };
    expect((await c.revokeInvite(a.authority, revoke)).kind).toBe('ok');
    expect(await c.revokeInvite(a.authority, revoke)).toMatchObject({ kind: 'ok', value: { replayed: true } });
    expect(await c.command(b.authority, 'request', q)).toEqual({ kind: 'refused', code: 'unavailable' });
    const missing = await c.resolveInvite(b.authority, { version, token: `ksfi_${'z'.repeat(43)}` });
    expect(await c.resolveInvite(b.authority, { version, token })).toEqual(missing);
    expect((await create(a, 2)).kind).toBe('ok');
    expect(await c.resolveInvite(b.authority, { version, token })).toEqual(missing);
    expect(await c.revokeInvite(a.authority, revoke)).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(
      await db.db.selectFrom('experience.exposures').select('id').where('universe_id', '=', b.universeId).execute(),
    ).toEqual([]);
  });
  it('uses pure absolute expiry and same coarse inactive/blocked/unknown resolution', async () => {
    const a = await person(),
      b = await person(),
      c = cases(),
      created = await create(a);
    if (created.kind !== 'ok' || created.value.delivery.status !== 'available') throw new Error('CI_CREATE');
    const token = created.value.delivery.token,
      before = await db.db.selectFrom('social.invites').selectAll().where('account_id', '=', a.accountId).execute();
    const missing = await c.resolveInvite(b.authority, { version, token: `ksfi_${'q'.repeat(43)}` });
    now += 604800000;
    expect(await c.resolveInvite(b.authority, { version, token })).toEqual(missing);
    expect(await c.readInvites(a.authority)).toMatchObject({
      kind: 'ok',
      value: { invite: { status: 'expired', inviteRevision: 1 } },
    });
    expect(
      await db.db.selectFrom('social.invites').selectAll().where('account_id', '=', a.accountId).execute(),
    ).toEqual(before);
    const next = await create(a, 1);
    if (next.kind !== 'ok' || next.value.delivery.status !== 'available') throw new Error('CI_CREATE');
    const nextToken = next.value.delivery.token;
    await c.command(b.authority, 'block', {
      version,
      commandId: randomUUID(),
      peerPersonId: a.person.personId,
      expectedPairRevision: 0,
    });
    expect(await c.resolveInvite(b.authority, { version, token: nextToken })).toEqual(missing);
    await accountAccessUseCases({ db: db.db, lockTimeoutMs: 5000 }).invalidateOwnAccountAccess(a.authority, 'suspend');
    expect(await c.resolveInvite(b.authority, { version, token: nextToken })).toEqual(missing);
  });
  it('rechecks a revoked invitation after a REAL issuer-account wait before request receipt/effects', async () => {
    const a = await person(),
      b = await person(),
      c = cases(),
      created = await create(a);
    if (created.kind !== 'ok' || created.value.delivery.status !== 'available') throw new Error('CI_CREATE');
    const other = createDatabase<Database>(db.settings, { onIdleClientError: () => undefined }),
      entered = gate(),
      release = gate();
    let pid = 0;
    const holder = makeWithPersonalScope(other.db, { lockTimeoutMs: 5000 })(a.authority, async (scope) => {
      await accountAccessUseCases({ db: other.db, lockTimeoutMs: 5000 }).fenceOwnAccount(scope);
      const tx = transactionOf(scope);
      pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!.pid;
      await tx
        .updateTable('social.invites')
        .set({ revoked: true, revision: 2 })
        .where('account_id', '=', a.accountId)
        .execute();
      entered.open();
      await release.promise;
    });
    await entered.promise;
    const q = {
      version,
      commandId: randomUUID(),
      expectedPeerPersonId: a.person.personId,
      expectedPairRevision: 0,
      target: { kind: 'invite', token: created.value.delivery.token },
    };
    const pending = c.command(b.authority, 'request', q);
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{
                blocked: boolean;
              }>`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) as blocked`.execute(
                db.db,
              )
            ).rows[0]!.blocked,
        )
        .toBe(true);
    } finally {
      release.open();
      try {
        await Promise.all([holder, pending]);
      } finally {
        await other.close();
      }
    }
    expect(await pending).toEqual({ kind: 'refused', code: 'unavailable' });
    expect(
      await db.db
        .selectFrom('receipts.shared_commands')
        .selectAll()
        .where('actor_account_id', '=', b.accountId)
        .where('command_id', '=', q.commandId)
        .execute(),
    ).toEqual([]);
    expect(
      await db.db.selectFrom('social.roster_entries').selectAll().where('owner_account_id', '=', b.accountId).execute(),
    ).toEqual([]);
  });
});
