/** Authored labelled media and real isolated origin/target PG. No provider or cross-world pool access. */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { migrationRegistry } from '@knowscroll/migrations';
import { applyQueueDeclarations, createBoss } from '@knowscroll/backend/infrastructure/jobs';
import { makeWithCutroomReceiveScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import {
  makeWithCutroomPreparationScope,
  postgresCutroomSettlement,
  makeEnqueueCutroom,
  makeEnqueueCutroomMaintenance,
} from '@knowscroll/backend/reasoning/nest-providers';
import {
  makeCommissionReceiveExport,
  receiveCutroomQueue,
  recoverReceiveCutroomQueue,
  type CommissionReceivePayload,
  type CommissionReceiveBinding,
  type ReceiveScopeTx,
  type ReceiveEnvelope,
  type WithReceiveScope,
  type ReceiveStore,
  type ReceiveMedia,
  type CommissionReceive,
} from '@knowscroll/backend/modules/content';
import {
  makeCommissionReceive,
  postgresCommissionReceive,
  postgresCommissionReceiveOrigin,
  makeReceiveMedia,
} from '@knowscroll/backend/modules/content/nest-providers';
import { commissionFixture, fixturePublishedCommission, type CommissionFixture } from './commission-fixture.js';
import { createTestDatabase, type TestDatabase } from './database.js';
export const receiveHash = (s: string) => createHash('sha256').update(s).digest('hex');
const latestMigration = migrationRegistry.at(-1)?.name;
if (!latestMigration || !/^\d{4}_/.test(latestMigration)) throw new Error('FIXTURE_SOURCE_SCHEMA_UNAVAILABLE');
/** This fixture's source database is cloned/migrated from this exact candidate's registry. */
export const receivingFixtureSchemaVersion = Number(latestMigration.slice(0, 4));
export interface ReceivingFixture {
  origin: CommissionFixture;
  published: Awaited<ReturnType<typeof fixturePublishedCommission>>;
  target: TestDatabase<Database>;
  boss: ReturnType<typeof createBoss>;
  root: string;
  stagingRoot: string;
  mediaRoot: string;
  authority: ReceiveScopeTx['authority'];
  withScope: WithReceiveScope;
  store: ReceiveStore;
  media: ReceiveMedia;
  bindings: Map<string, CommissionReceiveBinding>;
  service: CommissionReceive;
  exportPayload: ReturnType<typeof makeCommissionReceiveExport>;
  envelope: ReceiveEnvelope | undefined;
  bind(e: ReceiveEnvelope, generation?: number): CommissionReceiveBinding;
  transfer(e: ReceiveEnvelope): Promise<void>;
  close(): Promise<void>;
}
export async function receiveFixture(
  label: string,
  options: {
    readonly confirm?: boolean;
    readonly originWorld?: TestDatabase<Database>;
    readonly targetWorld?: TestDatabase<Database>;
    readonly runPrefix?: string;
  } = {},
): Promise<ReceivingFixture> {
  const origin = await commissionFixture(`receive_${label}`, {
    world: options.originWorld,
    runPrefix: options.runPrefix,
  });
  let published: Awaited<ReturnType<typeof fixturePublishedCommission>> | undefined;
  let target: Awaited<ReturnType<typeof createTestDatabase<Database>>> | undefined;
  let boss: ReturnType<typeof createBoss> | undefined;
  const root = await mkdtemp(join(tmpdir(), 'ks-receive-'));
  try {
    published = await fixturePublishedCommission(origin, `receive_${label}`);
    if (
      options.confirm !== false &&
      (await published.financial.process(published.c.target, published.published.operationId)) !== 'confirmed'
    )
      throw new Error('FIXTURE_SETTLEMENT');
    const reader = postgresCutroomSettlement(
      makeEnqueueCutroom(origin.boss),
      makeEnqueueCutroomMaintenance(origin.boss),
    );
    const exportPayload = makeCommissionReceiveExport(
      postgresCommissionReceiveOrigin({
        authority: { worldId: 'dev', generation: 1 },
        withScope: makeWithCutroomPreparationScope(origin.world.db, { enabled: true }),
        financial: reader,
        source: {
          commit: 'a'.repeat(40),
          artifactSha256: receiveHash('fixture-archive'),
          schemaVersion: receivingFixtureSchemaVersion,
        },
        fixture: true,
      }),
    );
    target = options.targetWorld ?? (await createTestDatabase<Database>(`receive_target_${label}`));
    boss = createBoss(target.settings, 'producer', { onError: () => undefined, onWarning: () => undefined });
    await boss.start();
    await applyQueueDeclarations(boss, [receiveCutroomQueue, recoverReceiveCutroomQueue]);
    await sql`insert into content.cutroom_receiving_state(world_id,generation,enabled) values('stage',1,true)`.execute(
      target.db,
    );
    const authority = { worldId: 'stage' as const, generation: 1 };
    const withScope = makeWithCutroomReceiveScope<ReceiveScopeTx>(target.db, { enabled: true, lockTimeoutMs: 5000 });
    const store = postgresCommissionReceive(target.db, boss, { enabled: true, ...authority, fixture: true });
    const bindings = new Map<string, CommissionReceiveBinding>();
    const stagingRoot = join(root, 'staging'),
      mediaRoot = join(root, 'media');
    const media = makeReceiveMedia({ stagingRoot, mediaRoot, ffprobePath: '/usr/bin/ffprobe' });
    const service = makeCommissionReceive({
      enabled: true,
      fixture: true,
      authority,
      withScope,
      store,
      media,
      now: Date.now,
      readBinding: (id, digest) => {
        const b = bindings.get(id);
        return Promise.resolve(b?.payloadSha256 === digest ? b : undefined);
      },
    });
    const envelope = await exportPayload({ publicationId: published.published.publicationId, targetWorld: 'stage' });
    function bind(e: ReceiveEnvelope, generation = 1) {
      const p = JSON.parse(e.payloadUtf8) as CommissionReceivePayload,
        now = Date.now();
      const b: CommissionReceiveBinding = {
        handoffId: p.handoffId,
        payloadSha256: e.payloadSha256,
        targetWorld: 'stage',
        generation,
        observedAtMs: now - 1,
        expiresAtMs: now + 299999,
        provenanceReviewSha256: receiveHash('fixture-provenance'),
        currentPolicyReviewSha256: receiveHash('fixture-current-policy'),
      };
      bindings.set(p.handoffId, b);
      return b;
    }
    async function transfer(e: ReceiveEnvelope) {
      const p = JSON.parse(e.payloadUtf8) as CommissionReceivePayload,
        dir = join(stagingRoot, p.handoffId);
      await mkdir(dir, { recursive: true, mode: 0o750 });
      await copyFile(join(published!.media.mediaRoot, p.media.key), join(dir, `${p.media.sha256}.mp4`));
    }
    return {
      origin,
      published,
      target,
      boss,
      root,
      stagingRoot,
      mediaRoot,
      authority,
      withScope,
      store,
      media,
      bindings,
      service,
      exportPayload,
      envelope,
      bind,
      transfer,
      close: async () => {
        await boss!.stop({ graceful: true, timeout: 5000 });
        await target!.drop();
        await published!.close();
        await origin.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await boss?.stop({ graceful: true, timeout: 5000 });
    await target?.drop();
    await published?.close();
    await origin.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
/** New authored proof variants for negative/budget fixtures; not exports of invented origin rows. */
export function receiveVariant(base: ReceiveEnvelope, change: (p: CommissionReceivePayload) => void): ReceiveEnvelope {
  const p = JSON.parse(base.payloadUtf8) as CommissionReceivePayload;
  change(p);
  const hex = receiveHash(
      JSON.stringify(['cutroom-receive.v1', p.originWorld, p.publicationId.toLowerCase(), p.targetWorld]),
    ).slice(0, 32),
    variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  p.handoffId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
  p.documentSha256 = receiveHash(JSON.stringify(p.document));
  const s = p.settlement;
  s.financialReportSha256 = receiveHash(
    JSON.stringify({
      version: 'cutroom-financial.v1',
      worldId: p.originWorld,
      businessRunId: p.businessRunId,
      attemptId: p.attemptId,
      requestId: p.requestId,
      requestSha256: p.requestSha256,
      dispatchId: s.dispatchId,
      poolReceipt: { bindingId: s.bindingId, claimedAt: s.claimedAt, boundAt: s.boundAt },
      runs: s.runs,
      finalRunId: s.finalRunId,
      outcome: 'completed',
      actualCents: s.actualCents,
    }),
  );
  const payloadUtf8 = JSON.stringify(p);
  return { payloadUtf8, payloadSha256: receiveHash(payloadUtf8) };
}
