/** Disposable pool protocol fixtures only: no live pool, provider, executor or billing proof. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { databaseUrl, quoteIdentifier, withAdmin } from './support/admin.js';

const grant = 'knowscroll-v2-d018';
const migrationRoot = new URL('../../ops/pool/migrations/', import.meta.url);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface Identity {
  request: string;
  digest: string;
  take: number;
  until: string;
  body: string;
  world: string;
  ceiling: number;
  approval: string;
}
function identity(label: string, world = 'dev', ceiling = 75, take = 1): Identity {
  const digest = hash(`labelled pool fixture:${label}`);
  return {
    request: `ks-reel-${digest.slice(0, 32)}-${take}`,
    digest,
    take,
    until: 'video',
    body: hash(`labelled body:${label}`),
    world,
    ceiling,
    approval: `fixture-approval:${label}`,
  };
}
const values = (i: Identity) => [i.request, i.digest, i.take, i.until, i.body, i.world, i.ceiling, i.approval];
const tuple = 'row($2,$3,$4,$5,$6,$7,$8,$9)::public.pool_v2_identity';
interface Receipt extends pg.QueryResultRow {
  status: string;
  order_row: string | null;
  binding_id: string | null;
}
async function claim(client: pg.Client, i: Identity, selectedGrant = grant): Promise<Receipt> {
  const result = await client.query<Receipt>(`select * from public.pool_v2_claim($1,${tuple})`, [
    selectedGrant,
    ...values(i),
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('Missing fixture claim result');
  return row;
}
async function readOrder(client: pg.Client, i: Identity, selectedGrant = grant) {
  return (
    await client.query<{ order_row: string; binding_id: string; bound_at: Date; pending_evidence: string[] }>(
      `select * from public.pool_v2_read_order($1,${tuple})`,
      [selectedGrant, ...values(i)],
    )
  ).rows;
}
async function settle(client: pg.Client, i: Identity, spent: string | number, final = 'fixture-run', evidence = 'one') {
  return (
    await client.query(`select * from public.pool_v2_settle($1,${tuple},$10,$11::bigint,$12,$13,$14)`, [
      grant,
      ...values(i),
      'completed',
      spent,
      final,
      hash(`fixture-evidence:${evidence}`),
      `fixture:${evidence}`,
    ])
  ).rows[0] as { status: string; evidence_id: string };
}
async function release(client: pg.Client, i: Identity) {
  return (
    await client.query<{ result: string }>(`select public.pool_v2_release_not_sent($1,${tuple}) as result`, [
      grant,
      ...values(i),
    ])
  ).rows[0]?.result;
}
async function status(client: pg.Client) {
  return (await client.query('select * from public.pool_v2_grant_status($1)', [grant])).rows[0] as {
    cap_cents: string;
    base_cents: string;
    effective_cents: string;
    grant_base_cents: string;
    grant_effective_cents: string;
    accounting_hold: boolean;
    pending_count: string;
    pending_evidence: string[];
    enabled: boolean;
    retired: boolean;
  };
}
async function legacyClaim(client: pg.Client, i: Identity) {
  return (await client.query('select * from public.pool_claim($1,$2,$3,$4,$5,$6,$7,$8)', values(i))).rows[0] as {
    status: string;
  };
}

// Unique disposable LOGIN roles authenticate with ephemeral fixture-only credentials.
// Connections genuinely start as the unprivileged login, so SET ROLE and SESSION
// AUTHORIZATION checks do not inherit the original superuser's escape capability.
describe('shared v2 grant (isolated pool PostgreSQL, authored accounting fixtures)', () => {
  const prefix = `ks_pool_${randomBytes(5).toString('hex')}`;
  const roles = {
    dev: `${prefix}_dev`,
    stage: `${prefix}_stage`,
    legacy: `${prefix}_legacy`,
    public: `${prefix}_public`,
  };
  const passwords = new Map(Object.values(roles).map((role) => [role, randomBytes(24).toString('hex')]));
  let name: string;
  let owner: pg.Client;
  let dev: pg.Client;
  let stage: pg.Client;
  let legacy: pg.Client;
  let outsider: pg.Client;
  let legacyRoleCreated = false;
  let legacyBefore: unknown;
  const clients: pg.Client[] = [];
  const old = identity('historical-unbound', 'legacy');
  let serial = 0;
  const session = async (role?: string) => {
    const url = new URL(databaseUrl(name));
    if (role !== undefined) {
      url.username = role;
      url.password = passwords.get(role) ?? '';
    }
    const client = new pg.Client({ connectionString: url.toString(), application_name: 'pool-v2-fixture' });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='8s'; set lock_timeout='4s'");
    return client;
  };
  const enable = () => owner.query('select public.pool_v2_admin_gate(true,false)');
  beforeAll(async () => {
    await withAdmin(async (client) => {
      const exists = await client.query("select 1 from pg_roles where rolname='ks_pool_client'");
      if (exists.rowCount === 0) {
        await client.query('create role ks_pool_client nologin');
        legacyRoleCreated = true;
      }
      for (const role of Object.values(roles))
        await client.query(
          `create role ${quoteIdentifier(role)} login noinherit password '${passwords.get(role) ?? ''}'`,
        );
      await client.query(`alter role ${quoteIdentifier(roles.legacy)} inherit`);
      await client.query(`grant ks_pool_client to ${quoteIdentifier(roles.legacy)}`);
    });
  });
  beforeEach(async () => {
    name = `${inject('runPrefix')}pool_${serial++}`;
    await withAdmin((client) => client.query(`create database ${quoteIdentifier(name)}`));
    owner = await session();
    const original = await readFile(new URL('0001_shared_pool.sql', migrationRoot), 'utf8');
    const seven = await readFile(new URL('0002_cap_seven_dollars.sql', migrationRoot), 'utf8');
    expect(hash(original)).toBe('955c43ccf106ca673b78eafa2b6291db2f9b6979f012dfd7d8d64283faec9831');
    expect(hash(seven)).toBe('5786ccee37f0df8047d9607f58afc7092de9bfba0de8b5b47e79c5e0a5c99d1e');
    await owner.query(original);
    await owner.query(seven);
    // Authored historical liability: the forward protocol must preserve the old row byte-for-byte.
    await legacyClaim(owner, old);
    await owner.query('select public.pool_settle($1,$2,$3,$4,$5)', [
      old.request,
      old.world,
      'completed',
      617,
      'old-run',
    ]);
    legacyBefore = (await owner.query('select to_jsonb(o) as row from public.pool_order o')).rows;
    await owner.query(await readFile(new URL('0003_v2_shared_grant.sql', migrationRoot), 'utf8'));
    dev = await session(roles.dev);
    stage = await session(roles.stage);
    legacy = await session(roles.legacy);
    outsider = await session(roles.public);
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
    await withAdmin((client) => client.query(`drop database ${quoteIdentifier(name)} with (force)`));
  });
  afterAll(async () => {
    await withAdmin(async (client) => {
      for (const role of Object.values(roles)) await client.query(`drop role ${quoteIdentifier(role)}`);
      if (legacyRoleCreated) await client.query('drop role ks_pool_client');
    });
  });
  async function provision() {
    for (const world of ['dev', 'stage'] as const) {
      await owner.query(
        'insert into public.pool_v2_principal(role_oid,role_name,world) select oid,rolname,$2 from pg_roles where rolname=$1',
        [roles[world], world],
      );
      const role = quoteIdentifier(roles[world]);
      await owner.query(`grant usage on type public.pool_v2_identity to ${role}`);
      await owner.query(`grant execute on function public.pool_v2_claim(text,public.pool_v2_identity),
        public.pool_v2_read_order(text,public.pool_v2_identity),public.pool_v2_grant_status(text),
        public.pool_v2_settle(text,public.pool_v2_identity,text,bigint,text,text,text) to ${role}`);
    }
  }
  async function allowFixtureRelease() {
    // Only tests may simulate the future separately-reviewed closed not_sent capability.
    // Ordinary v2 clients above deliberately never get this EXECUTE right.
    await owner.query(
      `grant execute on function public.pool_v2_release_not_sent(text,public.pool_v2_identity) to ${quoteIdentifier(roles.dev)}`,
    );
  }

  it('installs disabled with no mapping or client grants; preserves the legacy prefix and every old row', async () => {
    expect((await owner.query('select * from public.pool_v2_grant')).rows[0]).toMatchObject({
      grant_id: grant,
      cap_cents: 200,
      enabled: false,
      retired: false,
    });
    expect((await owner.query('select * from public.pool_v2_principal')).rows).toEqual([]);
    expect((await owner.query('select to_jsonb(o) as row from public.pool_order o')).rows).toEqual(legacyBefore);
    expect((await owner.query('select * from public.pool_budget_status()')).rows).toEqual([
      { cap_cents: 900, committed_cents: 617, left_cents: 283 },
    ]);
    await expect(claim(dev, identity('no-rights'))).rejects.toMatchObject({ code: '42501' });
    await owner.query(
      `grant usage on type public.pool_v2_identity to ${quoteIdentifier(roles.dev)}; grant execute on function public.pool_v2_claim(text,public.pool_v2_identity) to ${quoteIdentifier(roles.dev)}`,
    );
    await expect(claim(dev, identity('no-mapping'))).rejects.toThrow('pool_v2_principal_refused');
    await provision();
    expect((await claim(dev, identity('disabled'))).status).toBe('grant_disabled');
    expect((await claim(dev, identity('unknown'), 'other-grant')).status).toBe('grant_unknown');
  });

  it('shares one 200c grant across worlds, serializes remaining headroom, and independently enforces the 900c global cap', async () => {
    await provision();
    await enable();
    const a = identity('shared-a');
    const b = identity('shared-b', 'stage');
    expect((await Promise.all([claim(dev, a), claim(stage, b)])).map((r) => r.status)).toEqual(['claimed', 'claimed']);
    expect((await claim(dev, identity('third-75'))).status).toBe('grant_exceeded');
    const last = await Promise.all([
      claim(dev, identity('last-dev', 'dev', 50)),
      claim(stage, identity('last-stage', 'stage', 50)),
    ]);
    expect(last.map((r) => r.status).sort()).toEqual(['claimed', 'grant_exceeded']);
    expect(await status(dev)).toMatchObject({
      cap_cents: '900',
      base_cents: '817',
      grant_base_cents: '200',
      grant_effective_cents: '200',
      accounting_hold: false,
    });
    expect((await claim(dev, identity('201', 'dev', 1))).status).toBe('grant_exceeded');
    expect((await legacyClaim(legacy, identity('global-over', 'legacy', 84))).status).toBe('cap_exceeded');
    expect((await legacyClaim(legacy, identity('global-exact', 'legacy', 83))).status).toBe('claimed');
    expect((await legacyClaim(legacy, identity('global-one', 'legacy', 1))).status).toBe('cap_exceeded');
  });

  it('recovers one immutable receipt after lost acknowledgement and never adopts an unbound/foreign or conflicting tuple', async () => {
    await provision();
    await enable();
    const i = identity('replay');
    const first = await claim(dev, i);
    expect(await claim(dev, i)).toEqual({ ...first, status: 'already_claimed' });
    expect(await readOrder(dev, i)).toHaveLength(1);
    expect((await owner.query<{ n: number }>('select count(*)::int as n from public.pool_v2_order')).rows[0]?.n).toBe(
      1,
    );
    const changes: Partial<Identity>[] = [
      { body: hash('different body') },
      { ceiling: 74 },
      { approval: 'other-approval' },
      { digest: i.digest.slice(0, 32) + hash('different full digest').slice(32) },
    ];
    for (const change of changes) {
      expect((await claim(dev, { ...i, ...change })).status).toBe('identity_conflict');
      await expect(readOrder(dev, { ...i, ...change })).rejects.toThrow('pool_v2_identity_mismatch');
    }
    await expect(claim(dev, { ...i, world: 'stage' })).rejects.toThrow('pool_v2_world_mismatch');
    await expect(claim(stage, { ...i, world: 'stage' })).resolves.toMatchObject({
      status: 'identity_conflict',
      order_row: null,
      binding_id: null,
    });
    expect((await claim(dev, { ...i, take: 2, request: `${i.request.slice(0, -1)}2` })).status).toBe('script_conflict');
    expect((await claim(dev, { ...old, world: 'dev' })).status).toBe('identity_conflict');
    expect(await claim(dev, i, 'another')).toMatchObject({ status: 'grant_unknown', order_row: null });
    for (const change of [{ until: 'stills' }, { take: 2 }, { request: 'forged' }, { ceiling: 76 }, { approval: '' }])
      await expect(claim(dev, { ...i, ...change })).rejects.toThrow('pool_v2_invalid_identity');
    const other = identity('different request');
    await expect(readOrder(dev, other)).rejects.toThrow('pool_v2_identity_mismatch');
    expect((await legacyClaim(legacy, i)).status).toBe('grant_api_required');
    await expect(
      legacy.query('select public.pool_settle($1,$2,$3,$4,$5)', [i.request, i.world, 'completed', 1, 'foreign']),
    ).rejects.toThrow('grant_api_required');
    await expect(legacy.query('select public.pool_release($1,$2)', [i.request, i.world])).rejects.toThrow(
      'grant_api_required',
    );
    expect((await legacyClaim(legacy, old)).status).toBe('already_ordered');
    expect(
      (await owner.query('select to_jsonb(o) as row from public.pool_order o where request_id=$1', [old.request])).rows,
    ).toEqual(legacyBefore);
  });

  it('makes same-script cross-world races single-owner and rolls back order insertion when binding fails', async () => {
    await provision();
    await enable();
    const i = identity('same-script');
    const results = await Promise.all([claim(dev, i), claim(stage, { ...i, world: 'stage' })]);
    expect(results.map((r) => r.status).sort()).toEqual(['claimed', 'identity_conflict']);
    await owner.query(`create function public.fixture_binding_fail() returns trigger language plpgsql as $$ begin raise exception 'fixture_binding_failure'; end $$;
      create trigger fixture_binding_fail before insert on public.pool_v2_order for each row execute function public.fixture_binding_fail()`);
    const failed = identity('rollback');
    await expect(claim(dev, failed)).rejects.toThrow('fixture_binding_failure');
    expect(
      (await owner.query('select request_id from public.pool_order where request_id=$1', [failed.request])).rows,
    ).toEqual([]);
    expect(
      (await owner.query('select request_id from public.pool_v2_order where request_id=$1', [failed.request])).rows,
    ).toEqual([]);
    expect((await status(dev)).grant_base_cents).toBe('75');
    await owner.query(
      'drop trigger fixture_binding_fail on public.pool_v2_order; drop function public.fixture_binding_fail()',
    );
    expect((await claim(dev, failed)).status).toBe('claimed');
  });

  it('records 75→80 exactly, counts settlement replay once, and preserves terminal receipt across disable/retire', async () => {
    await provision();
    await enable();
    const i = identity('over-reservation');
    await claim(dev, i);
    await owner.query('select public.pool_v2_admin_gate(false,true)');
    expect((await claim(dev, identity('after-retire'))).status).toBe('grant_disabled');
    expect((await claim(dev, i)).status).toBe('grant_disabled');
    expect(await readOrder(dev, i)).toHaveLength(1);
    expect((await settle(dev, i, 80)).status).toBe('settled');
    expect((await settle(dev, i, 80)).status).toBe('already_settled');
    expect(await status(dev)).toMatchObject({
      grant_base_cents: '80',
      grant_effective_cents: '80',
      accounting_hold: false,
      pending_count: '0',
      retired: true,
    });
    expect((await claim(dev, i)).status).toBe('settled');
    expect(
      (
        await owner.query<{ spent_cents: number }>('select spent_cents from public.pool_order where request_id=$1', [
          i.request,
        ])
      ).rows[0]?.spent_cents,
    ).toBe(80);
    await expect(owner.query('select public.pool_v2_admin_gate(true,false)')).rejects.toThrow(
      'pool_v2_grant_immutable',
    );
    await expect(owner.query('update public.pool_v2_grant set cap_cents=199')).rejects.toThrow(
      'pool_v2_grant_immutable',
    );
    await expect(owner.query('delete from public.pool_v2_order')).rejects.toThrow('pool_v2_immutable');
  });

  it('records actuals over both caps without a false accounting hold or further admission', async () => {
    await provision();
    await enable();
    const i = identity('actual-over-caps');
    await claim(dev, i);
    expect((await settle(dev, i, 1000)).status).toBe('settled');
    expect(await status(dev)).toMatchObject({
      base_cents: '1617',
      effective_cents: '1617',
      grant_base_cents: '1000',
      grant_effective_cents: '1000',
      accounting_hold: false,
    });
    expect((await claim(dev, identity('over-cap-next', 'dev', 1))).status).toBe('cap_exceeded');
    expect((await legacyClaim(legacy, identity('over-cap-legacy', 'legacy', 1))).status).toBe('cap_exceeded');
    expect((await settle(dev, i, 1000)).status).toBe('already_settled');
  });

  it('retains 60 plus conflicting evidence80 as effective80, survives the inner setter exception and blocks every new claim', async () => {
    await provision();
    await enable();
    const i = identity('late-80');
    await claim(dev, i);
    await settle(dev, i, 60);
    const report = await settle(dev, i, 80, 'late-run', 'late-80');
    expect(report.status).toBe('held_needs_operator');
    expect(await settle(dev, i, 80, 'late-run', 'late-80')).toEqual(report);
    expect(await status(dev)).toMatchObject({
      base_cents: '677',
      effective_cents: '697',
      grant_base_cents: '60',
      grant_effective_cents: '80',
      accounting_hold: true,
      pending_count: '1',
      pending_evidence: [report.evidence_id],
    });
    expect(
      (
        await owner.query<{ spent_cents: number }>('select spent_cents from public.pool_order where request_id=$1', [
          i.request,
        ])
      ).rows[0]?.spent_cents,
    ).toBe(60);
    expect((await claim(dev, identity('hold-dev'))).status).toBe('accounting_hold');
    expect((await claim(stage, identity('hold-stage', 'stage'))).status).toBe('accounting_hold');
    expect((await legacyClaim(legacy, identity('hold-legacy', 'legacy'))).status).toBe('accounting_hold');
    expect((await settle(dev, i, 10, 'lower-run', 'lower')).status).toBe('held_needs_operator');
    await settle(dev, i, 60); // Exact old tuple cannot satisfy a different contradictory report.
    expect(await status(dev)).toMatchObject({ grant_effective_cents: '80', pending_count: '2', accounting_hold: true });
    await expect(settle(stage, { ...i, world: 'stage' }, 100)).rejects.toThrow('pool_v2_identity_mismatch');
    await expect(settle(dev, i, -1)).rejects.toThrow('pool_v2_invalid_report');
    await expect(settle(dev, i, 100, 'run', 'https://fixture.invalid/signed')).rejects.toThrow(
      'pool_v2_invalid_report',
    );
    await allowFixtureRelease();
    await expect(release(dev, i)).rejects.toThrow('pool_v2_accounting_hold');
    await expect(owner.query('delete from public.pool_v2_settlement_evidence where not satisfied')).rejects.toThrow(
      'pool_v2_immutable',
    );
  });

  it('preserves safe-integer costs beyond legacy integer range and outer rollback uncertainty without clipping/double addition', async () => {
    await provision();
    await enable();
    const a = identity('huge-a');
    const b = identity('huge-b');
    await claim(dev, a);
    await claim(dev, b);
    const pending = { identity: a, cents: '9007199254740991', final: 'big-run', evidence: 'big' };
    await dev.query('begin');
    const uncommitted = await settle(dev, pending.identity, pending.cents, pending.final, pending.evidence);
    expect(uncommitted.status).toBe('held_needs_operator');
    await dev.query('rollback');
    expect((await status(dev)).accounting_hold).toBe(false);
    // A caller retains this exact pending tuple across outer commit uncertainty; no release/resend.
    expect(await settle(dev, pending.identity, pending.cents, pending.final, pending.evidence)).toEqual(uncommitted);
    expect((await settle(dev, b, '9007199254740991', 'big-b', 'big-b')).status).toBe('held_needs_operator');
    expect(await status(dev)).toMatchObject({
      grant_base_cents: '150',
      grant_effective_cents: '18014398509481982',
      effective_cents: '18014398509482599',
      accounting_hold: true,
    });
    expect(
      (await owner.query('select reported_cents::text from public.pool_v2_settlement_evidence order by evidence_id'))
        .rows,
    ).toEqual([{ reported_cents: pending.cents }, { reported_cents: pending.cents }]);
    await expect(settle(dev, a, '9007199254740992')).rejects.toThrow('pool_v2_invalid_report');
    expect((await legacyClaim(legacy, identity('huge-block', 'legacy'))).status).toBe('accounting_hold');
  });

  it('withholds release from ordinary clients; a separately granted fixture capability releases once and late cost stays held', async () => {
    await provision();
    await enable();
    const i = identity('never-sent');
    await claim(dev, i);
    await expect(release(dev, i)).rejects.toMatchObject({ code: '42501' });
    await allowFixtureRelease();
    await owner.query('select public.pool_v2_admin_gate(false,false)');
    expect(await release(dev, i)).toBe('released');
    expect(await release(dev, i)).toBe('already_released');
    expect((await status(dev)).grant_base_cents).toBe('0');
    expect((await claim(dev, i)).status).toBe('released');
    expect((await settle(dev, i, 80, 'late-after-release', 'late-release')).status).toBe('held_needs_operator');
    expect(await status(dev)).toMatchObject({
      grant_base_cents: '0',
      grant_effective_cents: '80',
      accounting_hold: true,
    });
    expect(
      (await owner.query<{ state: string }>('select state from public.pool_order where request_id=$1', [i.request]))
        .rows[0]?.state,
    ).toBe('released');
  });

  it('keeps legacy unbound settle/release behavior while mixed mutators acquire the global lock before any grant/order', async () => {
    await provision();
    await enable();
    await allowFixtureRelease();
    const x = identity('legacy-open', 'legacy', 20);
    const y = identity('legacy-release', 'legacy', 20);
    await legacyClaim(legacy, x);
    await legacyClaim(legacy, y);
    await dev.query('begin');
    await claim(dev, identity('holds-global-grant'));
    // Former inversion: another session targets an order while v2 holds the grant.
    const wait = legacy.query('select public.pool_settle($1,$2,$3,$4,$5)', [x.request, x.world, 'failed', 10, null]);
    await expect
      .poll(
        async () =>
          (
            await owner.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
              [name],
            )
          ).rows[0]?.n,
      )
      .toBe(1);
    await dev.query('commit');
    await expect(wait).resolves.toMatchObject({ rows: [{ pool_settle: 'settled' }] });
    await legacy.query('begin');
    await legacy.query('select public.pool_release($1,$2)', [y.request, y.world]);
    const reverse = claim(stage, identity('waits-legacy', 'stage', 50));
    await expect
      .poll(
        async () =>
          (
            await owner.query<{ n: number }>(
              "select count(*)::int as n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
              [name],
            )
          ).rows[0]?.n,
      )
      .toBe(1);
    await legacy.query('commit');
    expect((await reverse).status).toBe('claimed');
    expect((await legacyClaim(legacy, y)).status).toBe('take_taken');
    expect((await legacy.query('select public.pool_release($1,$2)', [y.request, y.world])).rows).toEqual([
      { pool_release: 'already_released' },
    ]);
    const z = identity('mixed-release', 'dev', 20);
    await claim(dev, z);
    const mixed = await Promise.all([
      release(dev, z),
      settle(stage, identity('waits-legacy', 'stage', 50), 10),
      legacy.query('select public.pool_settle($1,$2,$3,$4,$5)', [x.request, x.world, 'failed', 10, null]),
      owner.query('select public.pool_v2_admin_gate(false,false)'),
    ]);
    expect(mixed[0]).toBe('released');
    expect(mixed[1]).toMatchObject({ status: 'settled' });
    const defs = await owner.query<{ proname: string; body: string }>(
      "select proname,prosrc as body from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='public' and proname in ('pool_claim','pool_settle','pool_release','pool_v2_claim','pool_v2_settle','pool_v2_release_not_sent','pool_v2_admin_gate')",
    );
    expect(defs.rows).toHaveLength(7);
    for (const fn of defs.rows)
      expect(fn.body.trim()).toMatch(/^(?:DECLARE[\s\S]*?\n)?BEGIN\s+PERFORM public\.pool_v2_lock\(\);/);
  });

  it('denies PUBLIC/tables/private cores/admin/legacy, inherited and SET ROLE escapes, world spoofing and temp shadowing', async () => {
    await provision();
    await enable();
    const i = identity('acl');
    for (const client of [dev, stage, outsider]) {
      for (const query of [
        'select * from public.pool_order',
        'select * from public.pool_v2_principal',
        'select * from public.pool_v2_settlement_evidence',
        'select public.pool_v2_lock()',
        "select public.pool_v2_release_core('x','dev')",
        'select public.pool_v2_admin_gate(true,false)',
        "select * from public.pool_claim('x','x',1,'video','x','dev',1,'x')",
      ])
        await expect(client.query(query)).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('set role ks_pool_client')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query(`set role ${quoteIdentifier(roles.legacy)}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(dev.query('set session authorization postgres')).rejects.toMatchObject({ code: '42501' });
    await expect(claim(dev, { ...i, world: 'stage' })).rejects.toThrow('pool_v2_world_mismatch');
    await expect(claim(outsider, i)).rejects.toMatchObject({ code: '42501' });
    // Even accidental future membership must not inherit a usable v2 principal.
    await owner.query(`grant ks_pool_client to ${quoteIdentifier(roles.dev)}`);
    await expect(claim(dev, i)).rejects.toThrow('pool_v2_principal_refused');
    await dev.query('set role ks_pool_client');
    await expect(legacyClaim(dev, identity('membership-bypass'))).rejects.toThrow('pool_v2_use_grant_api');
    await expect(claim(dev, i)).rejects.toMatchObject({ code: '42501' });
    await dev.query('reset role');
    await owner.query(`revoke ks_pool_client from ${quoteIdentifier(roles.dev)}`);
    await owner.query(`grant ${quoteIdentifier(roles.dev)} to ${quoteIdentifier(roles.public)}`);
    await outsider.query(`set role ${quoteIdentifier(roles.dev)}`);
    await expect(claim(outsider, i)).rejects.toThrow('pool_v2_principal_refused');
    await outsider.query('reset role');
    await owner.query(`revoke ${quoteIdentifier(roles.dev)} from ${quoteIdentifier(roles.public)}`);
    // Owner explicitly permits a writable namespace only in this fixture. All definer
    // references remain qualified; caller/temp functions never run as the definer.
    await owner.query(`grant create on schema public to ${quoteIdentifier(roles.dev)}`);
    await dev.query(`create temp table pool_order(request_id text); create temp table pool_v2_grant(grant_id text);
      create function public.fixture_shadow() returns void language plpgsql as $$ begin raise exception 'shadow-ran'; end $$;
      set search_path=pg_temp,public,pg_catalog`);
    expect((await claim(dev, i)).status).toBe('claimed');
    expect((await status(dev)).grant_base_cents).toBe('75');
    const acl = await owner.query<{ proname: string; safe: boolean; public_execute: boolean }>(`select p.proname,
      p.proconfig @> array['search_path=pg_catalog, pg_temp'] as safe,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef`);
    expect(acl.rows.length).toBeGreaterThanOrEqual(11);
    for (const row of acl.rows) expect(row).toMatchObject({ safe: true, public_execute: false });
  });
});
