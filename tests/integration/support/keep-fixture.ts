/** Authored canonical documents and real adapter instrumentation for Actions only; never product data. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresQueryCompiler, type Kysely, type KyselyPlugin } from 'kysely';
import { expect } from 'vitest';
import { admitDocument } from '@knowscroll/scroll-model/admission';
import type { ScrollDocument } from '@knowscroll/scroll-model';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { makeWithPersonalScope } from '@knowscroll/backend/infrastructure/postgres';
import type { WithPersonalScope } from '@knowscroll/backend/modules/identity';
import { accountAccessUseCases } from '@knowscroll/backend/modules/identity/nest-providers';
import {
  importEditorialScrollUseCase,
  lockKeepPositionTarget,
} from '@knowscroll/backend/modules/content/nest-providers';
import { keepPlaceUseCases } from '@knowscroll/backend/modules/experience/nest-providers';
import type { KeepEntryRef } from '@knowscroll/contracts';
import { worstDocument } from '../../../packages/scroll-model/src/test-support/worst-case.js';
import { seal } from '../../../packages/scroll-model/src/test-support/arbitraries.js';
import { seedPerson, type FixturePerson } from './fixtures.js';
import { starterSource } from './scroll.js';
export type KeepVariant = 'ordinary' | 'maximal' | 'reel';
export const hashKeepFixture = (value: string) => createHash('sha256').update(value).digest('hex');
export interface KeepFixture {
  readonly person: FixturePerson;
  readonly ref: { assetId: string; assetRevision: number };
  readonly entry: KeepEntryRef;
  readonly document: unknown;
  readonly documentSha256: string;
  readonly documentBytes: number;
}
export function maximalKeepDocument(assetId: string): ScrollDocument {
  const original = worstDocument();
  const document = seal(original.sections, {
    assetId,
    title: '[Fixture] maximum canonical proof',
    explanationUnitId: 'ci-keep-worst',
  });
  const admitted = admitDocument(document);
  expect(admitted.kind).toBe('valid');
  const blocks = document.sections.flatMap((s) => s.blocks),
    sims = blocks.filter((b) => b.type === 'simulation');
  expect(blocks).toHaveLength(80);
  expect(document.sections).toHaveLength(4);
  expect(sims).toHaveLength(8);
  expect(blocks.filter((b) => b.type === 'figure')).toHaveLength(12);
  expect(sims.reduce((n, b) => n + b.data.params.length, 0)).toBe(16);
  for (const sim of sims) {
    expect(sim.data.params.map((p) => (p.max - p.min) / p.step + 1)).toEqual([100, 100]);
    expect(sim.data.outputs).toHaveLength(6);
    expect(sim.data.constants).toHaveLength(12);
    expect(sim.data.outputs.filter((o) => o.formula.kind === 'power')).toHaveLength(5);
    expect(sim.data.view.kind).toBe('cards');
  }
  return document;
}
export async function seedKeepFixture(
  db: Kysely<Database>,
  variant: KeepVariant,
  person?: FixturePerson,
): Promise<KeepFixture> {
  const owner = person ?? (await seedPerson(db)),
    assetId = randomUUID(),
    ref = { assetId, assetRevision: 1 };
  let document: unknown, documentSha256: string;
  if (variant === 'ordinary') {
    const source = starterSource();
    source['assetId'] = assetId;
    source['reference'] = 'ci-keep-http-canonical';
    expect(await importEditorialScrollUseCase(db)(source)).toMatchObject({ kind: 'imported' });
    const row = await db
      .selectFrom('content.asset_revisions')
      .select(['document', 'document_sha256'])
      .where('asset_id', '=', assetId)
      .executeTakeFirstOrThrow();
    document = row.document;
    documentSha256 = row.document_sha256;
    expect(admitDocument(document).kind).toBe('valid');
  } else {
    const digest = hashKeepFixture(assetId),
      key = `sha256/${digest.slice(0, 2)}/${digest}.mp4`;
    document =
      variant === 'maximal'
        ? maximalKeepDocument(assetId)
        : {
            schemaVersion: 'reel-document.v1',
            assetId,
            revision: 1,
            title: '[Fixture] Keep HTTP Reel',
            summary: 'Authored metadata, no provider or actual media bytes',
            language: 'en',
            truthLabel: 'generated',
            fixture: true,
            captions: 'burned_in',
            mediaKey: key,
            durationMs: 25789,
            width: 720,
            height: 1280,
          };
    documentSha256 =
      variant === 'maximal' ? (document as ScrollDocument).integrity.sha256 : hashKeepFixture(JSON.stringify(document));
    await db
      .insertInto('content.assets')
      .values({ id: assetId, kind: variant === 'reel' ? 'reel' : 'scroll', revision: 1, status: 'admitted' })
      .execute();
    await db
      .insertInto('content.asset_revisions')
      .values({
        asset_id: assetId,
        revision: 1,
        provenance_kind: variant === 'reel' ? 'cutroom_import' : 'authored_editorial',
        document_version: variant === 'reel' ? 'reel-document.v1' : 'scroll-document.v1',
        document: JSON.stringify(document),
        document_sha256: documentSha256,
        title: variant === 'maximal' ? (document as ScrollDocument).title : '[Fixture] Keep HTTP Reel',
        explanation_unit_id:
          variant === 'maximal' ? (document as ScrollDocument).explanationUnitId : 'ci-keep-http-only',
        language: 'en',
        reading_facts: '{}',
      })
      .execute();
    if (variant === 'reel') {
      const mediaId = randomUUID();
      await db
        .insertInto('content.media_objects')
        .values({
          id: mediaId,
          logical_key: key,
          backend: 'local',
          sha256: digest,
          size_bytes: 1,
          mime: 'video/mp4',
          probe: JSON.stringify({ durationMs: 25789 }),
        })
        .execute();
      await db
        .insertInto('content.reel_imports')
        .values({
          run_id: randomUUID(),
          asset_id: assetId,
          asset_revision: 1,
          media_id: mediaId,
          script_name: 'greenhouse',
          fixture: true,
        })
        .execute();
    }
  }
  const member = await db
    .insertInto('experience.saved_items')
    .values({ universe_id: owner.universeId, ...{ asset_id: assetId, asset_revision: 1 }, saved_at: new Date() })
    .returning('saved_entry_id')
    .executeTakeFirstOrThrow();
  return {
    person: owner,
    ref,
    entry: { ...ref, savedEntryId: member.saved_entry_id },
    document,
    documentSha256,
    documentBytes: Buffer.byteLength(JSON.stringify(document)),
  };
}
export async function seedKeepSessions(db: Kysely<Database>, person: FixturePerson) {
  await db
    .insertInto('identity.email_addresses')
    .values({ account_id: person.accountId, address: `keep-${randomUUID()}@fixture.test` })
    .execute();
  const native = `kss_${randomBytes(32).toString('base64url')}`,
    web = `kss_${randomBytes(32).toString('base64url')}`;
  for (const [client, token] of [
    ['native', native],
    ['web', web],
  ] as const)
    await db
      .insertInto('identity.sessions')
      .values({
        id: randomUUID(),
        account_id: person.accountId,
        client,
        token_hash: hashKeepFixture(token),
        expires_at: new Date(Date.now() + 86400000),
      })
      .execute();
  return { native, web };
}
export interface KeepTiming {
  wallMs: number;
  cpuMs: number;
  txWallMs: number;
  commitAckSpanMs: number;
  targetWallMs: number;
  targetCpuMs: number;
  phases: { phase: string; wallMs: number }[];
}
const phaseOf = (sql: string): string => {
  if (sql.includes('"identity"."universes"')) return sql.startsWith('select') ? 'root-lock' : 'root-watermark';
  if (sql.includes('"identity"."accounts"')) return 'account-gate';
  if (sql.includes('"experience"."saved_items"')) return 'membership';
  if (sql.includes('"content"."assets"')) return sql.includes('for share') ? 'asset-share' : 'asset-head';
  if (sql.includes('"content"."asset_revisions"')) return 'canonical-document';
  if (sql.includes('"experience"."saved_places"')) return 'place';
  if (sql.includes('"receipts"."personal_commands"')) return 'receipt';
  if (sql.includes('pg_notify')) return 'hint';
  return 'other';
};
/** Times actual transactions/queries/target; no SQL, parameters, IDs or body values enter records. */
export function instrumentKeep(db: Kysely<Database>) {
  const active = new AsyncLocalStorage<KeepTiming>(),
    starts = new WeakMap<object, { at: number; phase: string }>(),
    compiler = new PostgresQueryCompiler();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (active.getStore())
        starts.set(queryId, { at: performance.now(), phase: phaseOf(compiler.compileQuery(node, queryId).sql) });
      return node;
    },
    transformResult({ result, queryId }) {
      const s = active.getStore(),
        q = starts.get(queryId);
      if (s && q) s.phases.push({ phase: q.phase, wallMs: performance.now() - q.at });
      starts.delete(queryId);
      return Promise.resolve(result);
    },
  };
  const observed = db.withPlugin(plugin),
    real = makeWithPersonalScope(observed, { lockTimeoutMs: 5000 });
  const withScope: WithPersonalScope = async (authority, work) => {
    const start = performance.now(),
      s = active.getStore();
    let callbackEnd: number | undefined;
    const value = await real(authority, async (scope) => {
      const value = await work(scope);
      callbackEnd = performance.now();
      return value;
    });
    if (s) {
      s.txWallMs = performance.now() - start;
      s.commitAckSpanMs = callbackEnd === undefined ? 0 : performance.now() - callbackEnd;
    }
    return value;
  };
  const cases = keepPlaceUseCases({
    withScope,
    fenceOwn: accountAccessUseCases({ db: observed, lockTimeoutMs: 5000 }).fenceOwnAccount,
    target: async (scope, owner, ref) => {
      const start = performance.now(),
        cpu = process.cpuUsage();
      const result = await lockKeepPositionTarget(scope, owner, ref);
      const s = active.getStore();
      if (s) {
        s.targetWallMs = performance.now() - start;
        const c = process.cpuUsage(cpu);
        s.targetCpuMs = (c.user + c.system) / 1000;
      }
      return result;
    },
  });
  return {
    cases,
    async measure<T>(work: () => Promise<T>): Promise<{ value: T; timing: KeepTiming }> {
      const timing: KeepTiming = {
          wallMs: 0,
          cpuMs: 0,
          txWallMs: 0,
          commitAckSpanMs: 0,
          targetWallMs: 0,
          targetCpuMs: 0,
          phases: [],
        },
        start = performance.now(),
        cpu = process.cpuUsage();
      const value = await active.run(timing, work);
      timing.wallMs = performance.now() - start;
      const c = process.cpuUsage(cpu);
      timing.cpuMs = (c.user + c.system) / 1000;
      return { value, timing };
    },
  };
}
export function keepProbeSummary(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
