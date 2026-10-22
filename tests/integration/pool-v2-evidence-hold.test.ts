/** Actions-only disposable pool/session fixtures. No actual pool, billing, import or provider proof. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { databaseUrl, quoteIdentifier, withAdmin } from './support/admin.js';

const grant = 'knowscroll-v2-d018';
const root = new URL('../../ops/pool/migrations/', import.meta.url);
const signature = 'public.pool_v2_record_evidence(text,public.pool_v2_identity,text,bigint,text,text,text)';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tuple = 'row($2,$3,$4,$5,$6,$7,$8,$9)::public.pool_v2_identity';
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
function identity(label: string, world = 'dev', ceiling = 75): Identity {
  const digest = hash(`authored evidence-hold fixture:${label}`);
  return {
    request: `ks-reel-${digest.slice(0, 32)}-1`,
    digest,
    take: 1,
    until: 'video',
    body: hash(`authored fixture body:${label}`),
    world,
    ceiling,
    approval: `fixture-approval:${label}`,
  };
}
const values = (i: Identity) => [i.request, i.digest, i.take, i.until, i.body, i.world, i.ceiling, i.approval];
interface Report {
  outcome: string | null;
  spent: number | string | null;
  final: string | null;
  digest: string | null;
  ref: string | null;
}
const report = (label = 'stable-chain', spent: Report['spent'] = 60): Report => ({
  outcome: 'completed',
  spent,
  final: 'fixture-original-and-child-final',
  digest: hash(`authored immutable report:${label}`),
  ref: `fixture:${label}`,
});
async function one<T extends pg.QueryResultRow>(
  client: pg.Client,
  text: string,
  parameters: unknown[] = [],
): Promise<T> {
  const row = (await client.query<T>(text, parameters)).rows[0];
  if (!row) throw new Error('Missing disposable fixture row');
  return row;
}
const claim = (client: pg.Client, i: Identity) =>
  one<{ status: string; binding_id: string }>(client, `select * from public.pool_v2_claim($1,${tuple})`, [
    grant,
    ...values(i),
  ]);
const readOrder = (client: pg.Client, i: Identity) =>
  one<{
    value: unknown;
    binding_id: string;
    bound_at: string;
    claimed_at: string;
    pending_evidence: string[];
  }>(
    client,
    `select to_jsonb(r.order_row) as value,r.binding_id::text,
  to_char(r.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at,
  to_char((r.order_row).claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at,
  r.pending_evidence from public.pool_v2_read_order($1,${tuple}) r`,
    [grant, ...values(i)],
  );
const accounting = (client: pg.Client) =>
  one<{
    base_cents: string;
    effective_cents: string;
    grant_base_cents: string;
    grant_effective_cents: string;
    pending_count: string;
    pending_evidence: string[];
    accounting_hold: boolean;
    enabled: boolean;
    retired: boolean;
  }>(client, 'select * from public.pool_v2_grant_status($1)', [grant]);
const invoke = (
  client: pg.Client,
  i: Identity,
  r: Report,
  fn: 'pool_v2_record_evidence' | 'pool_v2_settle' = 'pool_v2_record_evidence',
  selectedGrant = grant,
) =>
  one<{ status: string; evidence_id: string }>(
    client,
    `select * from public.${fn}($1,${tuple},$10,$11::bigint,$12,$13,$14)`,
    [selectedGrant, ...values(i), r.outcome, r.spent, r.final, r.digest, r.ref],
  );

// Fixture roles are unique and actually authenticate. SET ROLE never impersonates session_user.
describe('evidence-only global holds over the unchanged pool prefix (real disposable PG)', () => {
  const prefix = `ks_hold_${randomBytes(5).toString('hex')}`;
  const roles = {
    dev: `${prefix}_dev`,
    stage: `${prefix}_stage`,
    legacy: `${prefix}_legacy`,
    outsider: `${prefix}_outsider`,
  };
  const passwords = new Map(Object.values(roles).map((role) => [role, randomBytes(24).toString('hex')]));
  const clients: pg.Client[] = [];
  let name: string, owner: pg.Client, dev: pg.Client, stage: pg.Client, legacy: pg.Client, outsider: pg.Client;
  let serial = 0,
    beforeInstall: unknown,
    functionsBefore: unknown,
    forward: string;
  const session = async (role?: string) => {
    const url = new URL(databaseUrl(name));
    if (role) {
      url.username = role;
      url.password = passwords.get(role) ?? '';
    }
    const client = new pg.Client({ connectionString: url.toString(), application_name: 'pool-evidence-hold-fixture' });
    await client.connect();
    clients.push(client);
    await client.query("set statement_timeout='15s'; set lock_timeout='10s'");
    return client;
  };
  const functionSnapshot = () =>
    owner.query<{ value: unknown }>(`select jsonb_build_object(
    'definition',pg_get_functiondef(p.oid),'acl',p.proacl) as value from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'pool%' and p.proname<>'pool_v2_record_evidence' order by p.oid`);
  const tableSnapshot = async () => {
    const out: unknown[] = [];
    for (const table of [
      'pool_budget',
      'pool_order',
      'pool_v2_grant',
      'pool_v2_principal',
      'pool_v2_order',
      'pool_v2_settlement_evidence',
    ])
      out.push({
        table,
        rows: (
          await owner.query<{ value: unknown }>(
            `select to_jsonb(t) as value from public.${table} t order by to_jsonb(t)::text`,
          )
        ).rows,
      });
    return out;
  };
  const evidence = () =>
    owner.query<{ value: unknown }>(
      'select to_jsonb(e) as value from public.pool_v2_settlement_evidence e order by evidence_id',
    );
  beforeAll(async () => {
    forward = await readFile(new URL('0004_v2_evidence_hold.sql', root), 'utf8');
    await withAdmin(async (admin) => {
      for (const role of Object.values(roles))
        await admin.query(
          `create role ${quoteIdentifier(role)} login noinherit password '${passwords.get(role) ?? ''}'`,
        );
    });
  });
  beforeEach(async () => {
    name = `${inject('runPrefix')}hold_${serial++}`;
    await withAdmin((admin) => admin.query(`create database ${quoteIdentifier(name)}`));
    owner = await session();
    // Preserve the exact migration bytes. Revoke only this disposable database's automatic
    // optional legacy ACL before COMMIT, so another concurrently running pool fixture may
    // clean up its own ks_pool_client role without dependencies on this database.
    await owner.query('begin');
    for (const [file, digest] of [
      ['0001_shared_pool.sql', '955c43ccf106ca673b78eafa2b6291db2f9b6979f012dfd7d8d64283faec9831'],
      ['0002_cap_seven_dollars.sql', '5786ccee37f0df8047d9607f58afc7092de9bfba0de8b5b47e79c5e0a5c99d1e'],
      ['0003_v2_shared_grant.sql', 'fa35024932c2d3fb6eef5e4d48ca217dc8bdc756a11d7518b103ad89c56ecfc7'],
    ]) {
      const text = await readFile(new URL(file!, root), 'utf8');
      expect(hash(text)).toBe(digest);
      await owner.query(text);
    }
    await owner.query(`do $$ begin if exists(select 1 from pg_roles where rolname='ks_pool_client') then
      revoke all on all functions in schema public from ks_pool_client; end if; end $$`);
    await owner.query('commit');
    const old = identity('historical617', 'legacy');
    await owner.query('select * from public.pool_claim($1,$2,$3,$4,$5,$6,$7,$8)', values(old));
    await owner.query('select public.pool_settle($1,$2,$3,$4,$5)', [
      old.request,
      old.world,
      'completed',
      617,
      'fixture-historical-run',
    ]);
    beforeInstall = await tableSnapshot();
    functionsBefore = (await functionSnapshot()).rows;
    await owner.query(forward);
    dev = await session(roles.dev);
    stage = await session(roles.stage);
    legacy = await session(roles.legacy);
    outsider = await session(roles.outsider);
  });
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.end()));
    await withAdmin((admin) => admin.query(`drop database ${quoteIdentifier(name)} with (force)`));
  });
  afterAll(async () => {
    await withAdmin(async (admin) => {
      for (const role of Object.values(roles)) await admin.query(`drop role ${quoteIdentifier(role)}`);
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
        public.pool_v2_settle(text,public.pool_v2_identity,text,bigint,text,text,text),${signature} to ${role}`);
    }
    await owner.query(
      `grant execute on function public.pool_claim(text,text,integer,text,text,text,integer,text) to ${quoteIdentifier(roles.legacy)}`,
    );
    await owner.query('select public.pool_v2_admin_gate(true,false)');
  }
  async function blockedBothWorlds(i: Identity) {
    expect((await claim(dev, identity('blocked-dev'))).status).toBe('accounting_hold');
    expect((await claim(stage, identity('blocked-stage', 'stage'))).status).toBe('accounting_hold');
    expect((await claim(dev, i)).status).toBe('accounting_hold');
    const x = identity('blocked-legacy', 'legacy');
    expect(
      (await one<{ status: string }>(legacy, 'select * from public.pool_claim($1,$2,$3,$4,$5,$6,$7,$8)', values(x)))
        .status,
    ).toBe('accounting_hold');
  }

  it('adds only the owner-only definer, preserves every prefix function/table, and exports fixture provenance', async () => {
    expect(await tableSnapshot()).toEqual(beforeInstall);
    expect((await functionSnapshot()).rows).toEqual(functionsBefore);
    // pg_get_functiondef's type-name deparsing uses the query's visible schemas.
    // Publish a reproducible consumer pin in this explicit canonical read context.
    await owner.query('begin; set local search_path=pg_catalog,public,pg_temp');
    const metadata = await one<{ definition: string; safe: boolean; definer: boolean; owner_only: boolean }>(
      owner,
      `select pg_get_functiondef(p.oid) as definition,
      p.proconfig @> array['search_path=pg_catalog, pg_temp'] as safe,p.prosecdef as definer,
      not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type='EXECUTE' and a.grantee<>p.proowner) as owner_only
      from pg_proc p where p.oid=$1::regprocedure`,
      [signature],
    );
    await owner.query('commit');
    expect(metadata).toMatchObject({ safe: true, definer: true, owner_only: true });
    expect(metadata.definition).not.toContain('pool_v2_settle_core');
    expect(metadata.definition).not.toMatch(/\b(?:update|delete\s+from)\s+public\./i);
    process.stdout.write(
      JSON.stringify({
        label: 'Actions disposable PG function provenance only',
        function: signature,
        definition_search_path: 'pg_catalog, public, pg_temp',
        definition_sha256: hash(metadata.definition),
        migration_sha256: hash(forward),
      }) + '\n',
    );
    await expect(invoke(dev, identity('not-provisioned'), report())).rejects.toMatchObject({ code: '42501' });
  });

  it('records an under-ceiling import-failure hold without touching the claim, and exact lost-ACK replay retains its ID/timestamps', async () => {
    await provision();
    const i = identity('import-failed'),
      r = report('import-failed', 60);
    await claim(dev, i);
    const before = await readOrder(dev, i);
    expect(before.bound_at).toMatch(/\.\d{6}Z$/);
    expect(before.claimed_at).toMatch(/\.\d{6}Z$/);
    await invoke(dev, i, r); // Deliberately discard the application acknowledgement; commit is independently read below.
    const after = await readOrder(dev, i);
    expect(after.pending_evidence).toHaveLength(1);
    expect({ ...after, pending_evidence: [] }).toEqual(before);
    const stored = (await evidence()).rows;
    const resumed = await session(roles.dev),
      replay = await invoke(resumed, i, r);
    expect(replay).toEqual({ status: 'evidence_replayed', evidence_id: after.pending_evidence[0] });
    expect((await evidence()).rows).toEqual(stored);
    expect(await accounting(dev)).toMatchObject({
      base_cents: '692',
      effective_cents: '692',
      grant_base_cents: '75',
      grant_effective_cents: '75',
      accounting_hold: true,
      pending_count: '1',
    });
    await blockedBothWorlds(i);
    await expect(
      dev.query(`select public.pool_v2_release_not_sent($1,${tuple})`, [grant, ...values(i)]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it.each(['completed', 'refused', 'stopped', 'failed', 'cancelled'])(
    'holds a real terminal %s tuple including zero/nonvideo results without settling',
    async (outcome) => {
      await provision();
      const i = identity(`terminal-${outcome}`);
      await claim(dev, i);
      const before = await readOrder(dev, i);
      const r = {
        ...report(`nonvideo-${outcome}`, 0),
        outcome,
        final: outcome === 'completed' ? 'fixture-nonvideo-final' : null,
      };
      const result = await invoke(dev, i, r);
      expect(result.status).toBe('evidence_recorded');
      expect(await readOrder(dev, i)).toEqual({ ...before, pending_evidence: [result.evidence_id] });
      expect(await accounting(dev)).toMatchObject({
        grant_base_cents: '75',
        grant_effective_cents: '75',
        accounting_hold: true,
      });
    },
  );

  it('preserves huge actuals and bigint totals above all caps and JS-safe aggregate range, never clamps or releases', async () => {
    await provision();
    const a = identity('huge-a'),
      b = identity('huge-b', 'stage');
    await claim(dev, a);
    await claim(stage, b);
    const before = await tableSnapshot(),
      aBefore = await readOrder(dev, a),
      max = '9007199254740991';
    const ra = await invoke(dev, a, report('huge-a', max)),
      rb = await invoke(stage, b, report('huge-b', max));
    expect(ra.evidence_id).not.toBe(rb.evidence_id);
    expect(await accounting(dev)).toMatchObject({
      base_cents: '767',
      effective_cents: (2n * BigInt(max) + 617n).toString(),
      grant_base_cents: '150',
      grant_effective_cents: (2n * BigInt(max)).toString(),
      pending_count: '2',
    });
    expect((await tableSnapshot()).slice(0, 5)).toEqual(before.slice(0, 5));
    expect(
      (
        await owner.query<{ cost: string }>(
          'select reported_cents::text as cost from public.pool_v2_settlement_evidence order by evidence_id',
        )
      ).rows,
    ).toEqual([{ cost: max }, { cost: max }]);
    await blockedBothWorlds(a);
    await expect(owner.query('select * from public.pool_budget_status()')).resolves.toMatchObject({
      rows: [{ cap_cents: 900, committed_cents: 767, left_cents: 133 }],
    });
    expect(await invoke(dev, a, report('huge-a', max), 'pool_v2_settle')).toEqual({
      status: 'held_needs_operator',
      evidence_id: ra.evidence_id,
    });
    expect(await readOrder(dev, a)).toEqual({ ...aBefore, pending_evidence: [ra.evidence_id] });
  });

  it('retains every truthful report beyond the capped pending-ID read without treating absence as satisfaction', async () => {
    await provision();
    const i = identity('bounded-read');
    await claim(dev, i);
    const before = await readOrder(dev, i),
      ids: string[] = [];
    for (let n = 0; n < 33; n++)
      ids.push((await invoke(dev, i, report(`bounded-${n}`, n === 32 ? 1000 : n))).evidence_id);
    const read = await readOrder(dev, i);
    expect(read.pending_evidence).toEqual([...ids].sort().slice(0, 32));
    expect({ ...read, pending_evidence: [] }).toEqual(before);
    expect(await accounting(dev)).toMatchObject({
      pending_count: '33',
      grant_base_cents: '75',
      grant_effective_cents: '1000',
      accounting_hold: true,
    });
    const excluded = ids.find((id) => !read.pending_evidence.includes(id))!;
    const index = ids.indexOf(excluded);
    expect(await invoke(dev, i, report(`bounded-${index}`, index === 32 ? 1000 : index))).toEqual({
      status: 'evidence_replayed',
      evidence_id: excluded,
    });
    expect((await evidence()).rows).toHaveLength(33);
    await blockedBothWorlds(i);
  });

  it('uses the exact unchanged settlement ID and satisfies only its matching report; satisfied evidence never masquerades as a hold', async () => {
    await provision();
    const i = identity('later-import');
    await claim(dev, i);
    const a = report('verified-original', 60),
      b = report('contradictory-child', 80),
      low = report('lower-retry', 1);
    const ar = await invoke(dev, i, a),
      br = await invoke(dev, i, b),
      lr = await invoke(dev, i, low);
    expect(new Set([ar.evidence_id, br.evidence_id, lr.evidence_id]).size).toBe(3);
    expect(await invoke(dev, i, a, 'pool_v2_settle')).toEqual({ status: 'settled', evidence_id: ar.evidence_id });
    await expect(invoke(dev, i, a)).rejects.toThrow('pool_v2_evidence_satisfied');
    expect((await readOrder(dev, i)).pending_evidence.sort()).toEqual([br.evidence_id, lr.evidence_id].sort());
    expect(await invoke(dev, i, a, 'pool_v2_settle')).toEqual({
      status: 'already_settled',
      evidence_id: ar.evidence_id,
    });
    expect(await invoke(dev, i, b, 'pool_v2_settle')).toEqual({
      status: 'held_needs_operator',
      evidence_id: br.evidence_id,
    });
    expect(await accounting(dev)).toMatchObject({
      grant_base_cents: '60',
      grant_effective_cents: '80',
      accounting_hold: true,
      pending_count: '2',
    });
    await blockedBothWorlds(i);
  });

  it.each([false, true])(
    'retains exact late accounting after disabled/retired=%s without granting a new send',
    async (retired) => {
      await provision();
      const i = identity(`disabled-${retired}`);
      await claim(dev, i);
      const before = await readOrder(dev, i);
      await owner.query('select public.pool_v2_admin_gate(false,$1)', [retired]);
      expect((await claim(dev, i)).status).toBe('grant_disabled');
      const r = report('late80', 80),
        first = await invoke(dev, i, r);
      expect(first.status).toBe('evidence_recorded');
      expect(await invoke(dev, i, r)).toEqual({ ...first, status: 'evidence_replayed' });
      expect(await readOrder(dev, i)).toEqual({ ...before, pending_evidence: [first.evidence_id] });
      expect(await accounting(dev)).toMatchObject({
        enabled: false,
        retired,
        grant_base_cents: '75',
        grant_effective_cents: '80',
        accounting_hold: true,
      });
    },
  );

  it('records contradictory late cost after release or settlement while preserving those historical order bytes', async () => {
    await provision();
    const a = identity('released'),
      b = identity('settled', 'stage');
    await claim(dev, a);
    await claim(stage, b);
    // Explicit fixture-only capability grant; no ordinary client or installed migration receives it.
    await owner.query(
      `grant execute on function public.pool_v2_release_not_sent(text,public.pool_v2_identity) to ${quoteIdentifier(roles.dev)}`,
    );
    await dev.query(`select public.pool_v2_release_not_sent($1,${tuple})`, [grant, ...values(a)]);
    await invoke(stage, b, report('settled-original', 20), 'pool_v2_settle');
    const ab = await readOrder(dev, a),
      bb = await readOrder(stage, b);
    const ar = await invoke(dev, a, report('late-after-release', 80)),
      br = await invoke(stage, b, report('late-after-settle', 30));
    expect(await readOrder(dev, a)).toEqual({ ...ab, pending_evidence: [ar.evidence_id] });
    expect(await readOrder(stage, b)).toEqual({ ...bb, pending_evidence: [br.evidence_id] });
    expect(await accounting(dev)).toMatchObject({
      grant_base_cents: '20',
      grant_effective_cents: '110',
      pending_count: '2',
      accounting_hold: true,
    });
    await expect(
      dev.query(`select public.pool_v2_release_not_sent($1,${tuple})`, [grant, ...values(a)]),
    ).rejects.toThrow('pool_v2_accounting_hold');
  });

  it('refuses malformed identities, unknown/incomplete actuals and unsafe report values without inserting evidence', async () => {
    await provision();
    const i = identity('invalid');
    await claim(dev, i);
    const before = await readOrder(dev, i),
      r = report();
    for (const change of [
      { spent: null },
      { spent: -1 },
      { spent: '9007199254740992' },
      { outcome: null },
      { outcome: 'processing' },
      { final: null },
      { final: '' },
      { final: 'x'.repeat(1025) },
      { digest: null },
      { digest: 'A'.repeat(64) },
      { ref: null },
      { ref: 'https://private.invalid/value' },
      { ref: 'x'.repeat(201) },
    ])
      await expect(invoke(dev, i, { ...r, ...change })).rejects.toThrow('pool_v2_invalid_report');
    await expect(invoke(dev, i, { ...r, spent: '1.5' })).rejects.toMatchObject({ code: '22P02' });
    for (const change of [
      { until: 'stills' },
      { request: 'wrong' },
      { ceiling: 76 },
      { body: 'bad' },
      { approval: '' },
    ])
      await expect(invoke(dev, { ...i, ...change }, r)).rejects.toThrow('pool_v2_invalid_identity');
    for (const change of [
      { body: hash('other body') },
      { approval: 'other' },
      { ceiling: 74 },
      { digest: i.digest.slice(0, 32) + hash('different-full').slice(32) },
    ])
      await expect(invoke(dev, { ...i, ...change }, r)).rejects.toThrow('pool_v2_identity_mismatch');
    await expect(invoke(dev, i, r, 'pool_v2_record_evidence', 'other-grant')).rejects.toThrow(
      'pool_v2_identity_mismatch',
    );
    await expect(invoke(dev, identity('unknown-order'), r)).rejects.toThrow('pool_v2_identity_mismatch');
    const unbound = identity('legacy-unbound-dev', 'dev', 1);
    await owner.query('select * from public.pool_claim($1,$2,$3,$4,$5,$6,$7,$8)', values(unbound));
    await expect(invoke(dev, unbound, r)).rejects.toThrow('pool_v2_identity_mismatch');
    expect(await readOrder(dev, i)).toEqual(before);
    expect((await evidence()).rows).toEqual([]);
  });

  it('rolls back outer/fatal failures, then serializes concurrent identical reports and a waiting foreign-world claim', async () => {
    await provision();
    const i = identity('rollback-race');
    await claim(dev, i);
    const before = await readOrder(dev, i),
      r = report();
    await dev.query('begin');
    await invoke(dev, i, r);
    await dev.query('rollback');
    expect(await readOrder(dev, i)).toEqual(before);
    expect((await evidence()).rows).toEqual([]);
    await owner.query(`create function public.fixture_evidence_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture-evidence-failed'; end $$;
      create trigger fixture_evidence_failure before insert on public.pool_v2_settlement_evidence for each row execute function public.fixture_evidence_failure()`);
    await expect(invoke(dev, i, r)).rejects.toThrow('fixture-evidence-failed');
    expect(await readOrder(dev, i)).toEqual(before);
    expect((await evidence()).rows).toEqual([]);
    await owner.query(
      'drop trigger fixture_evidence_failure on public.pool_v2_settlement_evidence; drop function public.fixture_evidence_failure()',
    );
    const second = await session(roles.dev),
      results = await Promise.all([invoke(dev, i, r), invoke(second, i, r)]);
    expect(results.map((x) => x.status).sort()).toEqual(['evidence_recorded', 'evidence_replayed']);
    expect(results[0]?.evidence_id).toBe(results[1]?.evidence_id);
    expect((await evidence()).rows).toHaveLength(1);
    await dev.query('begin');
    await invoke(dev, i, r);
    const waiting = claim(stage, identity('wait-global', 'stage'));
    try {
      await expect
        .poll(
          async () =>
            (
              await one<{ n: number }>(
                owner,
                "select count(*)::int n from pg_stat_activity where datname=$1 and wait_event_type='Lock'",
                [name],
              )
            ).n,
          { timeout: 5000, interval: 20 },
        )
        .toBeGreaterThan(0);
    } finally {
      await dev.query('commit');
    }
    expect((await waiting).status).toBe('accounting_hold');
  });

  it('enforces actual session OID/name/world, membership and SET ROLE rather than current_user or body assertions', async () => {
    await provision();
    const i = identity('principal');
    await claim(dev, i);
    const r = report();
    await expect(invoke(stage, i, r)).rejects.toThrow('pool_v2_world_mismatch');
    await expect(invoke(stage, { ...i, world: 'stage' }, r)).rejects.toThrow('pool_v2_identity_mismatch');
    await owner.query(
      `grant usage on type public.pool_v2_identity to ${quoteIdentifier(roles.outsider)}; grant execute on function ${signature} to ${quoteIdentifier(roles.outsider)}`,
    );
    await owner.query('insert into public.pool_v2_principal(role_oid,role_name,world) values(0,$1,$2)', [
      roles.outsider,
      'dev',
    ]);
    await expect(invoke(outsider, i, r)).rejects.toThrow('pool_v2_principal_refused');
    await owner.query(
      `grant usage on type public.pool_v2_identity to ${quoteIdentifier(roles.legacy)}; grant execute on function ${signature} to ${quoteIdentifier(roles.legacy)}`,
    );
    await owner.query(
      'insert into public.pool_v2_principal(role_oid,role_name,world) select oid,$2,$3 from pg_roles where rolname=$1',
      [roles.legacy, `${prefix}_stale_name`, 'dev'],
    );
    await expect(invoke(legacy, i, r)).rejects.toThrow('pool_v2_principal_refused');
    await owner.query(`grant ${quoteIdentifier(roles.dev)} to ${quoteIdentifier(roles.outsider)}`);
    await outsider.query(`set role ${quoteIdentifier(roles.dev)}`);
    await expect(invoke(outsider, i, r)).rejects.toThrow('pool_v2_principal_refused');
    await outsider.query('reset role');
    await owner.query(`revoke ${quoteIdentifier(roles.dev)} from ${quoteIdentifier(roles.outsider)}`);
    await owner.query(`grant ${quoteIdentifier(roles.legacy)} to ${quoteIdentifier(roles.dev)}`);
    await expect(invoke(dev, i, r)).rejects.toThrow('pool_v2_principal_refused');
    await owner.query(`revoke ${quoteIdentifier(roles.legacy)} from ${quoteIdentifier(roles.dev)}`);
    await expect(dev.query(`set role ${quoteIdentifier(roles.stage)}`)).rejects.toMatchObject({ code: '42501' });
    expect((await evidence()).rows).toEqual([]);
  });

  it('denies direct table/private-core/release access and resists caller-writable/temp namespace shadowing', async () => {
    await provision();
    const i = identity('namespace');
    await claim(dev, i);
    for (const query of [
      'select * from public.pool_order',
      'select * from public.pool_v2_settlement_evidence',
      'select public.pool_v2_lock()',
      "select public.pool_v2_settle_core('x','dev','completed',0,'x')",
      "select public.pool_v2_release_core('x','dev')",
      'select public.pool_v2_admin_gate(true,false)',
    ])
      await expect(dev.query(query)).rejects.toMatchObject({ code: '42501' });
    await expect(
      dev.query(`select public.pool_v2_release_not_sent($1,${tuple})`, [grant, ...values(i)]),
    ).rejects.toMatchObject({ code: '42501' });
    await owner.query(`grant create on schema public to ${quoteIdentifier(roles.dev)}`);
    await dev.query(`create temp table pool_order(request_id text); create temp table pool_v2_settlement_evidence(evidence_id text);
      create function public.sha256(bytea) returns bytea language plpgsql as $$ begin raise exception 'fixture-shadow-ran'; end $$;
      set search_path=pg_temp,public,pg_catalog`);
    const first = await invoke(dev, i, report());
    expect(first.status).toBe('evidence_recorded');
    expect((await evidence()).rows).toHaveLength(1);
    expect((await dev.query('select * from pg_temp.pool_v2_settlement_evidence')).rows).toEqual([]);
    expect((await readOrder(dev, i)).pending_evidence).toEqual([first.evidence_id]);
  });

  it('refuses inherited non-owner default EXECUTE instead of silently provisioning or rewriting privileges', async () => {
    await owner.query(`drop function ${signature}`);
    const role = quoteIdentifier(roles.outsider);
    await owner.query(`alter default privileges grant execute on functions to ${role}`);
    await expect(owner.query(forward)).rejects.toThrow('pool_v2_evidence_acl_refused');
    expect(
      (await one<{ value: string | null }>(owner, 'select to_regprocedure($1)::text as value', [signature])).value,
    ).toBeNull();
    const defaults = await owner.query<{ allowed: boolean }>(
      `select exists(select 1 from pg_default_acl d, lateral aclexplode(d.defaclacl) a
      where a.grantee=(select oid from pg_roles where rolname=$1) and a.privilege_type='EXECUTE') as allowed`,
      [roles.outsider],
    );
    expect(defaults.rows[0]?.allowed).toBe(true);
    expect(await tableSnapshot()).toEqual(beforeInstall);
  });
});
