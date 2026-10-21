import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  makeCommission,
  postgresCommissionStore,
  lockCommissionBusiness,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  cutroomBFor,
  makeEnqueueCutroom,
  postgresCutroomLedger,
  type CutroomBPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import { cutroomPoolQueue, type CutroomScopeTx } from '@knowscroll/backend/reasoning';
import { seedPerson } from '../support/fixtures.js';
import { commissionFixture, hash, type CommissionFixture } from '../support/commission-fixture.js';
import { gate } from '../support/fixture-model.js';

describe('Content public commission B (real world PG/pg-boss; fictional script, no provider)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('content');
  });
  afterAll(async () => {
    await f.close();
  });
  async function counts() {
    return (
      await sql`select
  (select count(*) from content.reel_commissions) as business,
  (select count(*) from reasoning.cutroom_attempts) as attempts,
  (select count(*) from reasoning.cutroom_requests) as requests,
  (select count(*) from reasoning.cutroom_pool_operations) as operations,
  (select count(*) from pgboss.job where name='reasoning.cutroom-pool') as jobs`.execute(f.world.db)
    ).rows[0];
  }
  it('default disabled/empty owner registry, missing root and spoofed references create no rows or pool calls', async () => {
    const c = f.command('deny'),
      before = await counts();
    const disabled = cutroomBFor(f.world.db, f.boss);
    expect(await f.commission(disabled)(c.input)).toEqual({ kind: 'refused', code: 'disabled' });
    expect(await f.commission(f.service({ approvals: [] }))(c.input)).toEqual({ kind: 'refused', code: 'authority' });
    expect(
      await f.commission()({
        ...c.input,
        approvalReference: { ...c.input.approvalReference, ref: 'caller-not-human-approval' },
      }),
    ).toEqual({ kind: 'refused', code: 'authority' });
    await f.world.db.deleteFrom('reasoning.cutroom_scopes').where('world_id', '=', 'dev').execute();
    expect(await f.commission()(c.input)).toEqual({ kind: 'refused', code: 'disabled' });
    await f.world.db
      .insertInto('reasoning.cutroom_scopes')
      .values({ world_id: 'dev', generation: 1, enabled: true })
      .execute();
    expect(await counts()).toEqual(before);
    expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
  });
  it('atomically persists one approved candidate/business/exact request/intention/job; immutable replay allocates nothing', async () => {
    const c = f.command('atomic'),
      before = await counts(),
      b = f.actual(),
      request = f.commission(b);
    const result = await request(c.input);
    expect(result).toMatchObject({ kind: 'pending', state: 'reserved', poolState: 'pending' });
    expect(await request(c.input)).toEqual(result);
    expect(await counts()).toEqual(
      Object.fromEntries(Object.entries(before!).map(([k, v]) => [k, String(Number(v) + 1)])),
    );
    const row = await f.world.db
      .selectFrom('reasoning.cutroom_requests')
      .selectAll()
      .where('request_sha256', '=', c.prepared.requestSha256)
      .executeTakeFirstOrThrow();
    expect(row.request_utf8).toBe(c.prepared.requestUtf8);
    expect(row.byte_length).toBe(Buffer.byteLength(c.prepared.requestUtf8, 'utf8'));
    expect(row.byte_length).toBeGreaterThan(c.prepared.requestUtf8.length);
    const jobs = await sql<{
      data: object;
    }>`select data from pgboss.job where name='reasoning.cutroom-pool' and data->>'attemptId'=${row.attempt_id}`.execute(
      f.world.db,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(Object.keys(jobs.rows[0]!.data).sort()).toEqual(['attemptId', 'generation', 'operationId', 'v', 'worldId']);
    expect(JSON.stringify(jobs.rows)).not.toContain('requestUtf8');
    expect(JSON.stringify(jobs.rows)).not.toContain('narration');
    expect((await f.owner.query('select * from public.pool_order')).rows).toEqual([]);
  });
  it('does not reinterpret changed script/evidence/take/approval/world or arbitrary personal input as the same business', async () => {
    const c = f.command('identity');
    expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    const before = await counts();
    const changed = structuredClone(c.input);
    changed.script.title += ' changed';
    for (const input of [
      changed,
      { ...c.input, take: 2 },
      { ...c.input, principalName: 'different-session' },
      { ...c.input, approvalReference: { ...c.input.approvalReference, ref: 'other' } },
    ])
      expect(await f.commission()(input)).toEqual({ kind: 'held', code: 'identity' });
    expect(await f.commission()({ ...c.input, privateContext: 'personal-canary' })).toEqual({
      kind: 'refused',
      code: 'invalid',
    });
    expect(await f.commission()({ ...c.input, authority: { worldId: 'foreign', generation: 1 } })).toEqual({
      kind: 'refused',
      code: 'invalid',
    });
    expect(await counts()).toEqual(before);
  });
  it.each(['business', 'request', 'job', 'binding'] as const)(
    'rolls back all world stores and required job after injected %s failure',
    async (stage) => {
      const c = f.command(`rollback-${stage}`),
        before = await counts();
      const enqueue = makeEnqueueCutroom(f.boss),
        ledger = postgresCutroomLedger(async (...args) => {
          await enqueue(...args);
          if (stage === 'job') throw new Error('CI after job');
        });
      const hooked: Partial<CutroomBPorts> = {
        ledger:
          stage === 'request'
            ? {
                ...ledger,
                reserve: async (...args) => {
                  await ledger.reserve(...args);
                  throw new Error('CI after request');
                },
              }
            : ledger,
      };
      const b = f.service(hooked),
        store = {
          ...postgresCommissionStore,
          insert: async (...args: Parameters<typeof postgresCommissionStore.insert>) => {
            const inserted = await postgresCommissionStore.insert(...args);
            if (stage === 'business') throw new Error('CI after business');
            return inserted;
          },
          bind: async (...args: Parameters<typeof postgresCommissionStore.bind>) => {
            await postgresCommissionStore.bind(...args);
            if (stage === 'binding') throw new Error('CI after binding');
          },
        };
      const request = makeCommission({ reasoning: b, store, sha256: hash });
      await expect(request(c.input)).rejects.toThrow('CI after');
      expect(await counts()).toEqual(before);
      expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    },
  );
  it('snapshots the exact admitted candidate before a business-lock await; caller mutation cannot change protected bytes', async () => {
    const c = f.command('candidate-alias'),
      held = gate(),
      release = gate();
    const candidate = {
      ...c.approval,
      contractVersion: 1 as const,
      requestUtf8: c.prepared.requestUtf8,
      byteLength: c.prepared.byteLength,
    };
    const b = f.service({
      lockBusiness: async (scope, id) => {
        const valid = await lockCommissionBusiness(scope, id);
        held.open();
        await release.promise;
        return valid;
      },
    });
    const pending = b.withScope(c.input.authority, 'admit', async (scope) => {
      expect(
        await postgresCommissionStore.insert(
          scope,
          candidate,
          hash('fictional-command'),
          JSON.stringify(c.input.script),
        ),
      ).toBe(true);
      const result = await b.reserve(scope, candidate);
      if (result.kind === 'pending') await postgresCommissionStore.bind(scope, c.input.businessRunId, result.attemptId);
      return result;
    });
    await held.promise;
    candidate.requestUtf8 += ' ';
    candidate.requestSha256 = hash(candidate.requestUtf8);
    candidate.byteLength = Buffer.byteLength(candidate.requestUtf8, 'utf8');
    release.open();
    expect(await pending).toMatchObject({ kind: 'entered', value: { kind: 'pending' } });
    const request = await f.world.db
      .selectFrom('reasoning.cutroom_requests')
      .selectAll()
      .where('request_sha256', '=', c.prepared.requestSha256)
      .executeTakeFirstOrThrow();
    expect(request.request_utf8).toBe(c.prepared.requestUtf8);
  });
  it('concurrent duplicates produce exactly one immutable business/attempt/request/operation/job', async () => {
    const c = f.command('duplicate'),
      before = await counts();
    const [a, b] = await Promise.all([f.commission()(c.input), f.commission()(c.input)]);
    expect(a.kind).toBe('pending');
    expect(b).toEqual(a);
    expect(await counts()).toEqual(
      Object.fromEntries(Object.entries(before!).map(([k, v]) => [k, String(Number(v) + 1)])),
    );
  });
  it('rechecks disabled generation after root wait; registry mutation cannot create authority', async () => {
    const c = f.command('root-wait'),
      b = f.actual(),
      held = gate(),
      release = gate();
    const tx = f.world.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('reasoning.cutroom_scopes')
        .set({ generation: 2, enabled: false })
        .where('world_id', '=', 'dev')
        .execute();
      held.open();
      await release.promise;
    });
    await held.promise;
    const pending = f.commission(b)(c.input);
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                f.world.db,
              )
            ).rows[0]!.n,
          ),
        )
        .toBeGreaterThan(0);
    } finally {
      release.open();
    }
    await tx;
    expect(await pending).toMatchObject({ kind: 'refused' });
    await f.world.db
      .updateTable('reasoning.cutroom_scopes')
      .set({ generation: 1, enabled: true })
      .where('world_id', '=', 'dev')
      .execute();
    const empty: typeof f.approvals = [],
      snap = f.service({ approvals: empty });
    empty.push(c.approval);
    expect(await f.commission(snap)(c.input)).toEqual({ kind: 'refused', code: 'authority' });
  });
  it('forged or closed scope never gains a world transaction; scoped enqueue shares real rollback/lifetime', async () => {
    const c = f.command('scope'),
      b = f.actual();
    expect(await f.commission(b)(c.input)).toMatchObject({ kind: 'pending' });
    let closed: CutroomScopeTx | undefined;
    await b.withScope(c.input.authority, 'recover', (sc) => {
      closed = sc;
      return Promise.resolve();
    });
    const enqueue = makeEnqueueCutroom(f.boss);
    // Intentional test-only forged brands prove the private runtime map, never production authority.
    for (const scope of [closed!, { authority: c.input.authority, mode: 'admit', enabled: true } as CutroomScopeTx])
      await expect(
        enqueue(scope, cutroomPoolQueue, {
          v: 1,
          worldId: 'dev',
          generation: 1,
          attemptId: '00000000-0000-4000-8000-000000000001',
          operationId: '00000000-0000-4000-8000-000000000002',
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_CLOSED' });
  });
  it('actual personal epoch invalidation/full erasure leaves shared public business/requests/pool accounting untouched', async () => {
    const c = f.command('personal-clear');
    expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    const before = await counts(),
      orders = (await f.owner.query('select to_jsonb(o) from public.pool_order o')).rows;
    const person = await seedPerson(f.world.db),
      access = accountAccessUseCases({ db: f.world.db, lockTimeoutMs: 5000 });
    expect(await access.invalidateOwnAccountAccess(person.authority, 'advance_epoch')).toMatchObject({
      kind: 'entered',
    });
    await makeWithPersonalScope(f.world.db, { lockTimeoutMs: 5000 })(
      { ...person.authority, privacyEpoch: 2 },
      async (scope) => eraseUniverse(scope, personalStores),
    );
    expect(await counts()).toEqual(before);
    expect((await f.owner.query('select to_jsonb(o) from public.pool_order o')).rows).toEqual(orders);
  });
});

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  prepareCommissionReview,
  reelFingerprint,
  normalizeReelNarration,
  checkReelCorpus,
  type ReelCorpusRecord,
  type CommissionReviewPacket,
} from '@knowscroll/backend/modules/content';
import { makeCommissionReview, postgresCommissionReview } from '@knowscroll/backend/modules/content/nest-providers';
import { fixtureReview, fixtureCorpusManifest, fictionalScript } from '../support/commission-fixture.js';
const legacyBriefFixture = z.object({
  worldId: z.string(),
  narration: z.array(z.object({ text: z.string(), claimIds: z.array(z.string()) })),
  claims: z.array(z.object({ role: z.enum(['main', 'supporting']) })),
  claimSources: z.array(z.object({ assetId: z.string(), assetRevision: z.number() })),
  criteria: z.object({
    mustShow: z.array(z.object({ type: z.enum(['presence', 'event']) })),
    mustNotShow: z.array(z.object({ type: z.enum(['presence', 'event']) })),
    depictionPolicyVersion: z.string(),
  }),
  style: z.object({ id: z.string(), version: z.number() }),
  planVaryOn: z.enum(['shotCount', 'order', 'canonicalSubject', 'angle']).optional(),
});
function legacyDescriptors(raw: unknown) {
  const b = legacyBriefFixture.parse(raw);
  return {
    template: {
      narrationClaimCounts: b.narration.map((n) => n.claimIds.length),
      claimRoles: b.claims.map((c) => c.role).sort(),
      mustShowTypes: b.criteria.mustShow.map((c) => c.type).sort(),
      mustNotShowTypes: b.criteria.mustNotShow.map((c) => c.type).sort(),
      depictionPolicyVersion: b.criteria.depictionPolicyVersion,
      styleId: b.style.id,
      styleVersion: b.style.version,
      planVaryOn: b.planVaryOn ?? null,
    },
    argument: {
      worldId: b.worldId,
      sources: [...new Set(b.claimSources.map((s) => `${s.assetId}@${s.assetRevision}`))].sort(),
      narrationText: b.narration.map((n) => n.text.trim().replace(/\s+/g, ' ').toLowerCase()).sort(),
    },
  };
}
function corpusRow(packet: CommissionReviewPacket, id = 'fictional-old'): ReelCorpusRecord {
  const argument = {
    worldId: 'old-topic-not-ordering-world',
    sources: ['20000000-0000-4000-8000-000000000017@1'],
    narrationText: [...packet.bridge.narrationText],
  };
  return {
    sourceNamespace: 'fixture',
    generatedReelId: id,
    sourceSnapshotRevision: 'snapshot1',
    originalTemplateSha256: packet.templateSha256,
    originalArgumentSha256: reelFingerprint(argument),
    briefSha256: hash('fixture-oldbrief'),
    descriptorSourceRef: 'fixture-descriptor',
    algorithmEvidenceRef: 'legacy-gates-reviewed',
    template: packet.template,
    argument,
    bridgeSha256: packet.bridgeSha256,
  };
}
function proposedScript(script = fictionalScript('review')) {
  return {
    businessRunId: randomUUID(),
    worldId: 'dev',
    generation: 1,
    take: 1,
    ceilingCents: 1,
    rightsReviewRef: 'fixture-rights',
    framingReviewRef: 'fixture-framing',
    targetReviewRef: 'fixture-target',
    script,
  };
}
function packetOf(input: unknown) {
  const r = prepareCommissionReview(input);
  if (r.kind !== 'prepared') throw new Error('CI review invalid');
  return r.packet;
}

describe('C1 CF63 exact legacy projections and conservative narration bridge (source fixtures, no semantic novelty claim)', () => {
  it('retains canonical sorting, whitespace/case normalization and duplicate multiplicity without policy salt', () => {
    expect(reelFingerprint({ b: 2, a: 1 })).toBe(hash('{"a":1,"b":2}'));
    expect(normalizeReelNarration('  Café\n BLUE\tobject. ')).toBe('café blue object.');
    expect(reelFingerprint({ narrationText: ['x', 'x'] })).not.toBe(reelFingerprint({ narrationText: ['x'] }));
    expect(reelFingerprint({ narrationText: ['é'] })).not.toBe(reelFingerprint({ narrationText: ['e\u0301'] }));
  });
  it('ID/JSON order/criterion order/style-text changes cannot evade exact projections', () => {
    const input = proposedScript(),
      base = packetOf(input),
      script = structuredClone(input.script);
    script.claims[0]!.id = 'renamed';
    script.narration = script.narration.map((n) => ({ ...n, claimIds: ['renamed'] }));
    script.criteria.mustShow[0]!.claimId = 'renamed';
    script.style.text = 'Different cosmetic words';
    const other = packetOf({ ...input, script });
    expect(other.scriptSha256).not.toBe(base.scriptSha256);
    expect(other.templateSha256).toBe(base.templateSha256);
    expect(other.bridgeSha256).toBe(base.bridgeSha256);
    const record = corpusRow(base);
    expect(checkReelCorpus([record], fixtureCorpusManifest([record]), other)).toBe('repetition');
  });
  it('style ID/version, evidence/source permutation, narration order/case/whitespace and policy changes still hit the mandatory bridge', () => {
    const input = proposedScript(),
      base = packetOf(input),
      record = corpusRow(base),
      script = structuredClone(input.script);
    script.style.id = 'different';
    script.style.version = 3;
    script.criteria.depictionPolicyVersion = 'policy-new';
    script.evidence.sources.reverse();
    script.narration.reverse();
    script.narration = script.narration.map((n) => ({ ...n, text: `  ${n.text.toUpperCase()}  ` }));
    const p = packetOf({ ...input, script });
    expect(p.templateSha256).not.toBe(base.templateSha256);
    expect(p.bridgeSha256).toBe(base.bridgeSha256);
    expect(checkReelCorpus([record], fixtureCorpusManifest([record]), p)).toBe('repetition');
  });
  it('ordered claim-count changes can alter template but never clear equal narration', () => {
    const input = proposedScript(),
      base = packetOf(input),
      record = corpusRow(base),
      script = structuredClone(input.script);
    script.claims.push({ ...script.claims[0]!, id: 'claim2', role: 'supporting' });
    script.narration[0]!.claimIds.push('claim2');
    const p = packetOf({ ...input, script });
    expect(p.templateSha256).not.toBe(base.templateSha256);
    expect(p.bridgeSha256).toBe(base.bridgeSha256);
    expect(checkReelCorpus([record], fixtureCorpusManifest([record]), p)).toBe('repetition');
  });
  it('absence, partial inventory, unknown projection/version, old hash mismatch and missing bridge fail closed', () => {
    const p = packetOf(proposedScript()),
      r = corpusRow(p),
      m = fixtureCorpusManifest([r]);
    expect(checkReelCorpus([], m, p)).toBe('corpus_unavailable');
    expect(checkReelCorpus([{ ...r, originalTemplateSha256: hash('wrong') }], m, p)).toBe('corpus_unavailable');
    expect(checkReelCorpus([{ ...r, bridgeSha256: hash('wrong') }], m, p)).toBe('corpus_unavailable');
    expect(
      checkReelCorpus(
        [r],
        {
          ...m,
          requiredProjectionIds: ['new-template', 'legacy-argument-v1', 'narration-bridge-v1'],
        } as unknown as typeof m,
        p,
      ),
    ).toBe('corpus_unavailable');
    expect(checkReelCorpus([{ ...r, algorithmVersion: 'reset-v2' }], m, p)).toBe('corpus_unavailable');
  });
  it('reads all fourteen retained source INPUTS, including four/five-unit scripts; these are not actual stamped DB rows or only the three imports', async () => {
    const names = [
      'greenhouse',
      'seasons',
      'seasons-v2',
      'seasons-v3',
      'seasons-v4',
      'seasons-v5',
      'sunburn',
      'sunburn-v2',
      'sunburn-v3',
      'sunburn-v4',
      'tides',
      'tides-v2',
      'tides-v3',
      'tides-v4',
    ];
    const counts: number[] = [];
    for (const name of names) {
      const raw: unknown = JSON.parse(
        await readFile(new URL(`../../../content/reel-scripts/${name}.json`, import.meta.url), 'utf8'),
      );
      const envelope = z.object({ brief: legacyBriefFixture }).parse(raw),
        d = legacyDescriptors(envelope.brief);
      counts.push(d.template.narrationClaimCounts.length);
      // A hand-written direct legacy payload has no schema/version/domain salt or ordering-world substitution.
      const templateHash = reelFingerprint(d.template),
        argumentHash = reelFingerprint(d.argument),
        bridgeHash = reelFingerprint({ narrationText: d.argument.narrationText });
      const record: ReelCorpusRecord = {
        sourceNamespace: 'fixture',
        generatedReelId: `retained-${name}`,
        sourceSnapshotRevision: 'snapshot1',
        originalTemplateSha256: templateHash,
        originalArgumentSha256: argumentHash,
        briefSha256: hash(JSON.stringify(envelope.brief)),
        descriptorSourceRef: 'retained-source-input-only',
        algorithmEvidenceRef: 'legacy-gates-reviewed',
        template: d.template,
        argument: d.argument,
        bridgeSha256: bridgeHash,
      };
      expect(checkReelCorpus([record], fixtureCorpusManifest([record]), packetOf(proposedScript()))).toBe('clear');
      expect(d.argument.worldId).not.toBe('dev');
      expect(templateHash).toMatch(/^[0-9a-f]{64}$/);
      expect(argumentHash).not.toBe(bridgeHash);
    }
    expect(counts).toHaveLength(14);
    expect(counts).toContain(4);
    expect(counts).toContain(5);
  });
});

describe('C1 trusted review admission and all-status corpus serialization (real PG; fictional approvals)', () => {
  let f: CommissionFixture;
  beforeAll(async () => {
    f = await commissionFixture('review');
  });
  afterAll(async () => {
    await f.close();
  });
  it('source packet is concrete but never approval; empty registry/completeness/ref spoof create no review', async () => {
    const c = f.command('unapproved'),
      r = fixtureReview(c.input),
      b = f.service();
    expect(await f.commission(b)(c.input)).toMatchObject({ kind: 'pending' });
    expect(r.packet.script).toEqual(c.input.script);
    expect(r.packet.requestSha256).toBe(c.prepared.requestSha256);
    expect(r.packet.byteLength).toBe(c.prepared.byteLength);
    for (const options of [
      {},
      { enabled: true },
      { enabled: true, approvals: [r.human] },
      { enabled: true, approvals: [{ ...r.human, reviewSha256: hash('spoof') }], manifests: [fixtureCorpusManifest()] },
    ]) {
      const review = makeCommissionReview(postgresCommissionReview, options);
      const result = await b.withScope(c.input.authority, 'admit', (scope) => review.admit(scope, r.packet));
      expect(result).toMatchObject({ kind: 'entered', value: { kind: 'refused' } });
    }
    expect(await f.world.db.selectFrom('content.cutroom_reviews').selectAll().execute()).toEqual([]);
  });
  it('serializes concurrent duplicate-template businesses, permits only exact self replay, and refuses revoked review/current generation', async () => {
    const a = f.command('race1'),
      b = f.command('race2');
    expect(await f.commission()(a.input)).toMatchObject({ kind: 'pending' });
    expect(await f.commission()(b.input)).toMatchObject({ kind: 'pending' });
    const ar = fixtureReview(a.input),
      br = fixtureReview(b.input),
      review = makeCommissionReview(postgresCommissionReview, {
        enabled: true,
        approvals: [ar.human, br.human],
        manifests: [fixtureCorpusManifest()],
      });
    const admit = (c: typeof a, r: typeof ar) =>
      f.service().withScope(c.input.authority, 'admit', (scope) => review.admit(scope, r.packet));
    const results = await Promise.all([admit(a, ar), admit(b, br)]);
    expect(results.filter((r) => r.kind === 'entered' && r.value.kind === 'reviewed')).toHaveLength(1);
    expect(
      results.filter((r) => r.kind === 'entered' && r.value.kind === 'refused' && r.value.code === 'repetition'),
    ).toHaveLength(1);
    const winner =
      results[0].kind === 'entered' && results[0].value.kind === 'reviewed' ? ([a, ar] as const) : ([b, br] as const);
    expect(await admit(winner[0], winner[1])).toMatchObject({ kind: 'entered', value: { kind: 'reviewed' } });
    await f.world.db
      .updateTable('content.cutroom_reviews')
      .set({ revoked_at: new Date() })
      .where('business_run_id', '=', winner[0].input.businessRunId)
      .execute();
    expect(
      await f
        .service()
        .withScope(winner[0].input.authority, 'admit', (scope) => review.recheck(scope, winner[0].input.businessRunId)),
    ).toEqual({ kind: 'entered', value: undefined });
    await expect(f.world.db.deleteFrom('content.cutroom_reviews').execute()).rejects.toThrow(
      'cutroom_review_immutable',
    );
  });
  it('keeps duplicate historical fingerprints as distinct immutable rows and requires complete unchanged corpus, independent of availability', async () => {
    const p = packetOf(proposedScript()),
      r = corpusRow(p, 'history1'),
      r2 = { ...r, generatedReelId: 'history2' }; // Includes a refused/withdrawn historical collision; no availability column filters it.
    for (const record of [r, r2]) {
      const utf8 = JSON.stringify(record);
      await f.world.db
        .insertInto('content.cutroom_corpus')
        .values({
          source_namespace: record.sourceNamespace,
          generated_reel_id: record.generatedReelId,
          record_utf8: utf8,
          record_sha256: hash(utf8),
          original_template_sha256: record.originalTemplateSha256,
          original_argument_sha256: record.originalArgumentSha256,
          bridge_sha256: record.bridgeSha256,
        })
        .execute();
    }
    expect(await f.world.db.selectFrom('content.cutroom_corpus').selectAll().execute()).toHaveLength(2);
    expect(checkReelCorpus([r, r2], fixtureCorpusManifest([r, r2]), p)).toBe('repetition');
    await expect(f.world.db.deleteFrom('content.cutroom_corpus').execute()).rejects.toThrow(
      'cutroom_execution_immutable',
    );
    const c = f.command('after-corpus'),
      review = fixtureReview(c.input);
    expect(await f.commission()(c.input)).toMatchObject({ kind: 'pending' });
    const service = makeCommissionReview(postgresCommissionReview, {
      enabled: true,
      approvals: [review.human],
      manifests: [fixtureCorpusManifest()],
    });
    expect(
      await f.service().withScope(c.input.authority, 'admit', (scope) => service.admit(scope, review.packet)),
    ).toMatchObject({ kind: 'entered', value: { kind: 'refused', code: 'corpus_unavailable' } });
  });
});
