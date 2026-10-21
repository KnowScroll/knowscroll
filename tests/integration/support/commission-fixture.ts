/** Authored fictional public script and isolated world/pool fixtures, never owner approval or billing. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { inject } from 'vitest';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  CutroomCommissionScriptSchema,
  lintCutroomCommission,
  prepareCutroomCommission,
  type CutroomCommissionScript,
} from '@knowscroll/backend/modules/content';
import {
  makeCommission,
  postgresCommissionStore,
  lockCommissionBusiness,
  makeCommissionReview,
  postgresCommissionReview,
} from '@knowscroll/backend/modules/content/nest-providers';
import {
  cutroomBFor,
  makeWithCutroomScope,
  makeCutroomB,
  makeEnqueueCutroom,
  postgresCutroomLedger,
  makeCutroomPool,
  type CutroomBPorts,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  cutroomAccountingQueue,
  cutroomFollowQueue,
  cutroomPoolQueue,
  type CutroomOwnerApproval,
  type CutroomB,
} from '@knowscroll/backend/reasoning';
import { createTestDatabase, type TestDatabase } from './database.js';
import { databaseUrl, quoteIdentifier, withAdmin } from './admin.js';
export const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
export function fictionalScript(label: string): CutroomCommissionScript {
  const excerpt = `A fictional source describes imaginary object ${label}.`;
  return {
    policyVersion: 'cutroom-commission.v1',
    scriptVersion: 'fixture.v1',
    title: `[Fixture] ${label}`,
    evidence: {
      version: 'cutroom-public-evidence.v1',
      reviewRef: 'fictional-review',
      sources: [
        {
          id: 'source1',
          url: 'https://example.invalid/fiction',
          retrievedAt: '2026-10-21T00:00:00Z',
          excerpt,
          excerptSha256: hash(excerpt),
        },
      ],
    },
    claims: [
      {
        id: 'claim1',
        role: 'main',
        statement: 'An imaginary object appears.',
        support: [{ sourceId: 'source1', excerptSha256: hash(excerpt) }],
      },
    ],
    narration: Array.from({ length: 6 }, (_, i) => ({
      text: `Imaginary ${i === 0 ? 'café' : 'blue'} object number ${i + 1} appears.`,
      claimIds: ['claim1'],
    })),
    criteria: {
      mustShow: [{ id: 'show1', text: 'A fictional blue object', type: 'presence', claimId: 'claim1' }],
      mustNotShow: [],
      depictionPolicyVersion: 'fiction.v1',
    },
    style: { id: 'fiction', version: 1, text: 'Labelled fictional illustration' },
  };
}
export interface CommissionInput {
  businessRunId: string;
  authority: { worldId: 'dev'; generation: number };
  script: CutroomCommissionScript;
  approvalReference: { ref: string; scriptSha256: string };
  take: number;
  ceilingCents: number;
  principalOid: string;
  principalName: string;
  grantRef: 'knowscroll-v2-d018';
}
export interface CommissionFixture {
  world: TestDatabase<Database>;
  owner: pg.Client;
  pool: pg.Pool;
  boss: ReturnType<typeof createBoss>;
  role: string;
  principalOid: string;
  approvals: CutroomOwnerApproval[];
  command(
    tag: string,
    ceilingCents?: number,
    fixtureDistinctTemplate?: boolean,
  ): {
    input: CommissionInput;
    approval: CutroomOwnerApproval;
    prepared: Extract<ReturnType<typeof prepareCutroomCommission>, { kind: 'prepared' }>;
  };
  ports(overrides?: Partial<CutroomBPorts>): CutroomBPorts;
  service(overrides?: Partial<CutroomBPorts>): CutroomB;
  commission(b?: CutroomB): ReturnType<typeof makeCommission>;
  actual(): CutroomB;
  grantReleaseForFixtureOnly(): Promise<void>;
  close(): Promise<void>;
}
export async function commissionFixture(label: string): Promise<CommissionFixture> {
  const world = await createTestDatabase<Database>(`commission_${label}`),
    poolName = `${inject('runPrefix')}cutroom_${randomBytes(4).toString('hex')}`;
  const role = `ks_b_${randomBytes(7).toString('hex')}`,
    legacyRole = `ks_b_legacy_${randomBytes(6).toString('hex')}`,
    password = randomBytes(24).toString('hex');
  await withAdmin(async (admin) => {
    await admin.query(`create database ${quoteIdentifier(poolName)}`);
    await admin.query(`create role ${quoteIdentifier(role)} login noinherit password '${password}'`);
    await admin.query(`create role ${quoteIdentifier(legacyRole)} nologin`);
  });
  const owner = new pg.Client({ connectionString: databaseUrl(poolName) });
  await owner.connect();
  for (const name of ['0001_shared_pool.sql', '0002_cap_seven_dollars.sql', '0003_v2_shared_grant.sql']) {
    const source = await readFile(new URL(`../../../ops/pool/migrations/${name}`, import.meta.url), 'utf8');
    // Only the optional legacy ACL's fixture role is isolated: concurrent old fixtures own ks_pool_client.
    await owner.query(name === '0001_shared_pool.sql' ? source.replaceAll('ks_pool_client', legacyRole) : source);
  }
  await owner.query(
    'insert into public.pool_v2_principal(role_oid,role_name,world) select oid,rolname,$2 from pg_catalog.pg_roles where rolname=$1',
    [role, 'dev'],
  );
  const principalOid = (
    await owner.query<{ oid: string }>('select oid::text from pg_catalog.pg_roles where rolname=$1', [role])
  ).rows[0]!.oid;
  await owner.query(`grant usage on type public.pool_v2_identity to ${quoteIdentifier(role)}`);
  await owner.query(
    `grant execute on function public.pool_v2_claim(text,public.pool_v2_identity),public.pool_v2_read_order(text,public.pool_v2_identity),public.pool_v2_grant_status(text) to ${quoteIdentifier(role)}`,
  );
  await owner.query('select public.pool_v2_admin_gate(true,false)');
  const url = new URL(databaseUrl(poolName));
  url.username = role;
  url.password = password;
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 3,
    connectionTimeoutMillis: 5000,
    application_name: 'ci-cutroom-b',
  });
  const boss = createBoss(world.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
  await boss.start();
  await applyQueueDeclarations(boss, [cutroomPoolQueue, cutroomAccountingQueue, cutroomFollowQueue]);
  await world.db
    .insertInto('reasoning.cutroom_scopes')
    .values({ world_id: 'dev', generation: 1, enabled: true })
    .execute();
  const approvals: CutroomOwnerApproval[] = [];
  const command = (tag: string, ceilingCents = 1, fixtureDistinctTemplate = false) => {
    const authored = fictionalScript(`${label}-${tag}`);
    if (fixtureDistinctTemplate) {
      authored.style.id = `fixture-${tag}`;
      authored.narration = authored.narration.map((n) => ({ ...n, text: `Fixture ${tag} ${n.text}` }));
    }
    const script = CutroomCommissionScriptSchema.parse(authored),
      lint = lintCutroomCommission(script);
    if (lint.kind !== 'valid') throw new Error('CI fictional package invalid');
    const approvalReference = { ref: 'fictional-reference-only', scriptSha256: lint.scriptSha256 };
    const prepared = prepareCutroomCommission(script, approvalReference, { take: 1, worldId: 'dev', ceilingCents });
    if (prepared.kind !== 'prepared') throw new Error('CI fictional prepare refused');
    const input = {
      businessRunId: randomUUID(),
      authority: { worldId: 'dev' as const, generation: 1 },
      script,
      approvalReference,
      take: 1,
      ceilingCents,
      principalOid,
      principalName: role,
      grantRef: 'knowscroll-v2-d018' as const,
    };
    const approval: CutroomOwnerApproval = {
      businessRunId: input.businessRunId,
      generation: 1,
      worldId: 'dev',
      policyVersion: 'cutroom-commission.v1',
      scriptSha256: prepared.scriptSha256,
      evidenceSha256: prepared.evidenceSha256,
      requestSha256: prepared.requestSha256,
      requestId: prepared.requestId,
      take: 1,
      until: 'video',
      ceilingCents,
      grantRef: 'knowscroll-v2-d018',
      approvalRef: prepared.approvalRef,
      principalOid,
      principalName: role,
    };
    approvals.push(approval);
    return { input, approval, prepared };
  };
  const ports = (overrides: Partial<CutroomBPorts> = {}): CutroomBPorts => ({
    withScope: makeWithCutroomScope(world.db, { enabled: true, lockTimeoutMs: 5000 }),
    ledger: postgresCutroomLedger(makeEnqueueCutroom(boss)),
    pool: makeCutroomPool(() => pool.connect()),
    lockBusiness: lockCommissionBusiness,
    approvals: [...approvals],
    enabled: true,
    now: () => new Date(),
    sha256: hash,
    byteLength: (s) => Buffer.byteLength(s, 'utf8'),
    ...overrides,
  });
  const service = (overrides: Partial<CutroomBPorts> = {}) => makeCutroomB(ports(overrides));
  const commission = (b: CutroomB = service()) =>
    makeCommission({ reasoning: b, store: postgresCommissionStore, sha256: hash });
  const actual = () =>
    cutroomBFor(world.db, boss, {
      enabled: true,
      approvals: [...approvals],
      lockBusiness: lockCommissionBusiness,
      connectPool: () => pool.connect(),
    });
  return {
    world,
    owner,
    pool,
    boss,
    role,
    principalOid,
    approvals,
    command,
    ports,
    service,
    commission,
    actual,
    async grantReleaseForFixtureOnly() {
      await owner.query(
        `grant execute on function public.pool_v2_release_not_sent(text,public.pool_v2_identity) to ${quoteIdentifier(role)}`,
      );
    },
    async close() {
      await boss.stop({ graceful: false });
      await pool.end();
      await owner.end();
      await world.drop();
      await withAdmin(async (a) => {
        await a.query(`drop database ${quoteIdentifier(poolName)} with (force)`);
        await a.query(`drop role ${quoteIdentifier(role)}`);
        await a.query(`drop role ${quoteIdentifier(legacyRole)}`);
      });
    },
  };
}

import {
  reelFingerprint,
  type ReelCorpusManifest,
  type ReelCorpusRecord,
  type CommissionReviewPacket,
  type CommissionHumanApproval,
} from '@knowscroll/backend/modules/content';
/** Authored trusted-completeness stand-in, NEVER an actual corpus inventory or owner approval. */
export function fixtureCorpusManifest(records: readonly ReelCorpusRecord[] = []): ReelCorpusManifest {
  const sorted = [...records].sort((a, b) =>
    `${a.sourceNamespace}:${a.generatedReelId}` < `${b.sourceNamespace}:${b.generatedReelId}` ? -1 : 1,
  );
  return {
    version: 'reel-corpus-completeness.v1',
    snapshotId: 'fictional-complete.v1',
    sourceScopesAndRevisions: ['fixture:snapshot1'],
    totalCount: sorted.length,
    allPagesDigest: reelFingerprint(sorted),
    descriptorMappingDigest: reelFingerprint(
      sorted.map((r) => ({
        sourceNamespace: r.sourceNamespace,
        generatedReelId: r.generatedReelId,
        briefSha256: r.briefSha256,
        descriptorSourceRef: r.descriptorSourceRef,
        algorithmEvidenceRef: r.algorithmEvidenceRef,
      })),
    ),
    requiredProjectionIds: ['legacy-template-v1', 'legacy-argument-v1', 'narration-bridge-v1'],
    trustedReviewCommandSha256: hash('fictional-trusted-corpus-review'),
  };
}
export async function fixtureReview(
  f: CommissionFixture,
  input: CommissionInput,
): Promise<{
  proposal: object;
  packet: CommissionReviewPacket;
  human: CommissionHumanApproval;
}> {
  const proposal = {
    businessRunId: input.businessRunId,
    worldId: input.authority.worldId,
    generation: input.authority.generation,
    take: input.take,
    ceilingCents: input.ceilingCents,
    rightsReviewRef: 'fixture-rights',
    framingReviewRef: 'fixture-framing',
    targetReviewRef: 'fixture-target',
    script: input.script,
  };
  const review = makeCommissionReview(postgresCommissionReview, {
    enabled: true,
    manifests: [fixtureCorpusManifest()],
  });
  const r = await f.service().withScope(input.authority, 'admit', (scope) => review.prepare(scope, proposal));
  if (r.kind !== 'entered' || r.value.kind !== 'prepared') throw new Error('FICTIONAL_REVIEW_INVALID');
  const p = r.value.packet;
  return {
    proposal,
    packet: p,
    human: {
      businessRunId: p.businessRunId,
      worldId: p.worldId,
      generation: p.generation,
      reviewSha256: p.reviewSha256,
      scriptSha256: p.scriptSha256,
      evidenceSha256: p.evidenceSha256,
      requestSha256: p.requestSha256,
      ceilingCents: p.ceilingCents,
      humanEvidenceRef: 'fixture-human-only',
    },
  };
}

import { cutroomExecutionFor, makeWithCutroomAccountingScope } from '@knowscroll/backend/reasoning/nest-providers';
import { sql } from 'kysely';
import type { CutroomDispatchPreflight } from '@knowscroll/backend/reasoning';
/** Genuine disposable B claim + C1 dispatch intent. NEVER consumes/sends its ephemeral permit. */
export async function fixtureDispatchedCommission(f: CommissionFixture, label: string) {
  const command = f.command(label, 1, true),
    reviewed = await fixtureReview(f, command.input);
  const admitted = await f.commission()(command.input);
  if (admitted.kind !== 'pending') throw new Error('CI_CHAIN_ADMISSION');
  const target = { worldId: 'dev' as const, businessRunId: command.input.businessRunId, attemptId: admitted.attemptId };
  const review = makeCommissionReview(postgresCommissionReview, {
    enabled: true,
    approvals: [reviewed.human],
    manifests: [fixtureCorpusManifest()],
  });
  const accepted = await f
    .service()
    .withScope(command.input.authority, 'admit', (scope) => review.admit(scope, reviewed.packet));
  if (accepted.kind !== 'entered' || accepted.value.kind !== 'reviewed') throw new Error('CI_CHAIN_REVIEW');
  const claimed = await f.service().claim(command.input.authority, admitted.attemptId);
  if (claimed.kind !== 'pending' || claimed.poolState !== 'claimed') throw new Error('CI_CHAIN_CLAIM');
  const a = await f.world.db
    .selectFrom('reasoning.cutroom_attempts')
    .select(['fence', 'binding_id'])
    .where('id', '=', admitted.attemptId)
    .executeTakeFirstOrThrow();
  const receipt = (
    await sql<{ claimed: string; bound: string }>`select
    to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') claimed,
    to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound
    from reasoning.cutroom_attempts where id=${admitted.attemptId}::uuid`.execute(f.world.db)
  ).rows[0]!;
  const now = new Date();
  const preflight: CutroomDispatchPreflight = {
    attemptId: admitted.attemptId,
    requestSha256: command.prepared.requestSha256,
    fence: a.fence,
    profileSha256: hash('fixture-engine'),
    soleWriterEvidenceSha256: hash('fixture-sole-writer'),
    fundsEvidenceSha256: hash('fixture-funds-not-real'),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30000).toISOString(),
    availableCents: 200,
    poolReceipt: { bindingId: a.binding_id!, claimedAt: receipt.claimed, boundAt: receipt.bound },
  };
  const execution = cutroomExecutionFor(f.world.db, f.boss, {
    enabled: true,
    recheckReview: review.recheck,
    preflights: [preflight],
    now: () => now,
  });
  const dispatched = await execution.prepareIntent(command.input.authority, admitted.attemptId);
  if (dispatched.kind !== 'prepared') throw new Error('CI_CHAIN_INTENT');
  return {
    ...command,
    target,
    preflight,
    execution,
    accounting: makeWithCutroomAccountingScope(f.world.db, { enabled: true, lockTimeoutMs: 5000 }),
    expected: {
      ...target,
      requestId: command.prepared.requestId,
      scriptSha256: command.prepared.scriptSha256,
      requestSha256: command.prepared.requestSha256,
      contractVersion: 1 as const,
      take: command.input.take,
      ceilingCents: command.input.ceilingCents,
    },
  };
}
