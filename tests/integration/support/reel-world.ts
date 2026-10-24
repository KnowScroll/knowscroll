import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { checkShippedReelScript, composeReelOperator } from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from './database.js';
import { TEST_DATABASE_PREFIX, databaseUrl, quoteIdentifier, withAdmin } from './admin.js';
import { startFakeCutroom, type FakeCutroom, type PostMode } from './fake-cutroom.js';

/** CI has ffprobe at /usr/bin; a Mac usually has it under Homebrew. */
const ffprobePath = ['/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((path) =>
  existsSync(path),
);
const poolMigrations = new URL('../../../ops/pool/migrations/', import.meta.url);

const FIXTURE_APPROVAL = 'fixture: earlier v1 spend';

/** A disposable shared pool: the real pool functions on a throwaway database. */
export interface TestPool {
  readonly client: pg.Pool;
  readonly name: string;
  /** Settles `cents` of earlier spend, as v1's orders did, in the pool's own functions. */
  seedSettled(cents: number): Promise<void>;
  /** Applies the cap migration (0005) once the earlier spend is seeded. */
  raiseCap(): Promise<void>;
  budget(): Promise<{ cap_cents: number; committed_cents: number; left_cents: number }>;
  /** The orders of the world under test: the seeded earlier spend is left out. */
  orders(): Promise<readonly Record<string, unknown>[]>;
  drop(): Promise<void>;
}

async function applyPoolMigration(client: pg.Pool, name: string): Promise<void> {
  await client.query(await readFile(new URL(name, poolMigrations), 'utf8'));
}

/** The pool as v1 left it (migrations 0001 and 0002, cap 700), ready for `seedSettled` and `raiseCap`. */
export async function createTestPool(): Promise<TestPool> {
  const name = `${TEST_DATABASE_PREFIX}pool_${randomBytes(4).toString('hex')}`;
  await withAdmin((admin) => admin.query(`create database ${quoteIdentifier(name)}`));
  const client = new pg.Pool({ connectionString: databaseUrl(name), max: 4 });
  await applyPoolMigration(client, '0001_shared_pool.sql');
  await applyPoolMigration(client, '0002_cap_seven_dollars.sql');
  let seeded = 0;
  return {
    client,
    name,
    async seedSettled(cents) {
      // One order is at most 500 cents in the pool, so a larger sum is several orders.
      for (let left = cents; left > 0; left -= 100) {
        const spent = Math.min(100, left);
        const digest = randomBytes(32).toString('hex');
        const requestId = `ks-reel-${digest.slice(0, 32)}-1`;
        await client.query('select * from pool_claim($1,$2,1,$3,$4,$5,$6,$7)', [
          requestId,
          digest,
          'video',
          randomBytes(32).toString('hex'),
          'dev',
          spent,
          FIXTURE_APPROVAL,
        ]);
        await client.query('select pool_settle($1,$2,$3,$4,$5)', [
          requestId,
          'dev',
          'completed',
          spent,
          `fixture-run-${++seeded}`,
        ]);
      }
    },
    raiseCap: () => applyPoolMigration(client, '0005_cap_four_dollars_more.sql'),
    async budget() {
      return (await client.query('select * from pool_budget_status()')).rows[0] as {
        cap_cents: number;
        committed_cents: number;
        left_cents: number;
      };
    },
    async orders() {
      const { rows } = await client.query<Record<string, unknown>>('select * from pool_orders()');
      return rows.filter((row) => row.approval_ref !== FIXTURE_APPROVAL);
    },
    async drop() {
      await client.end();
      await withAdmin((admin) => admin.query(`drop database if exists ${quoteIdentifier(name)} with (force)`));
    },
  };
}

/** One admitted Scroll a script can twin. Labelled: nothing here was written by a model. */
export async function seedTwinScroll(
  db: TestDatabase<Database>['db'],
  twin: { readonly assetId: string; readonly explanationUnitId: string },
): Promise<void> {
  await sql`insert into content.assets (id, revision, kind, status) values (${twin.assetId}::uuid, 1, 'scroll', 'admitted')`.execute(
    db,
  );
  await sql`insert into content.asset_revisions
      (asset_id, revision, provenance_kind, document_version, document, document_sha256, explanation_unit_id, language, title, reading_facts)
    values (${twin.assetId}::uuid, 1, 'generated', 'scroll-document.v1', ${JSON.stringify({ title: '[Fixture] twin', dek: 'fixture' })}::jsonb,
      ${'0'.repeat(64)}, ${twin.explanationUnitId}, 'en', '[Fixture] twin', '{}'::jsonb)`.execute(db);
}

type Operator = ReturnType<typeof composeReelOperator>;
type Scripts = Parameters<typeof composeReelOperator>[3];

export interface JoinedWorld {
  readonly name: 'dev' | 'stage';
  readonly db: TestDatabase<Database>;
  readonly mediaRoot: string;
  readonly operator: Operator;
}

export interface ReelWorld {
  readonly cutroom: FakeCutroom;
  readonly pool: TestPool;
  readonly root: string;
  /** A world (its database and operator) that orders from the shared fixture Cutroom and pool. */
  join(name: 'dev' | 'stage', clock?: () => Date): Promise<JoinedWorld>;
  /** Another operator over the same world, as after a release that ships other scripts. */
  operatorWith(joined: JoinedWorld, scripts: Scripts): Operator;
  /**
   * A finished rehearsal of a shipped script in a world, as `reel order --until plan` and `reel follow`
   * leave it. A paid order needs one, and its estimate decides whether the script may be ordered.
   */
  rehearse(operator: Operator, scriptName: string, estimateCents?: number): Promise<void>;
  setPostMode(mode: PostMode): void;
  close(): Promise<void>;
}

/**
 * The fixture world of the Reel tests: one fake Cutroom, one disposable pool with the cap raised
 * (617 cents already settled, 400 left), and any
 * number of worlds (databases) sharing them, as dev and stage share the real ones.
 */
export async function createReelWorld(
  options: { readonly onPost?: (body: string) => Promise<void> } = {},
): Promise<ReelWorld> {
  // macOS temp folders are symlinks; the media store and artifact reader refuse those.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ks-reel-'));
  const cutroom = await startFakeCutroom(root, options.onPost);
  // The pool as the owner saw it before the allowance: 617 cents settled by v1, then migration 0005.
  const pool = await createTestPool();
  await pool.seedSettled(617);
  await pool.raiseCap();
  const worlds: TestDatabase<Database>[] = [];
  const operatorOn = (
    db: TestDatabase<Database>,
    name: string,
    mediaRoot: string,
    clock?: () => Date,
    scripts?: Scripts,
  ) =>
    composeReelOperator(
      db.db,
      pool.client,
      {
        world: name,
        cutroomOrigin: cutroom.origin,
        cutroomArtifactRoot: cutroom.artifactRoot,
        mediaRoot,
        ffprobePath,
        now: clock,
      },
      scripts,
    );
  return {
    cutroom,
    pool,
    root,
    setPostMode: cutroom.setPostMode,
    async rehearse(operator, scriptName, estimateCents = 48) {
      const check = checkShippedReelScript({ scriptName });
      if (check.kind !== 'ok') throw new Error('shipped script refused');
      const ordered = await operator.order({ scriptName, until: 'plan', ceilingCents: 75, retake: false });
      if (ordered.kind !== 'sent') throw new Error(`rehearsal not sent: ${ordered.kind}`);
      cutroom.finishPlan(check.rehearsal.requestId, estimateCents);
      const followed = await operator.follow({ scriptName, until: 'plan' });
      if (followed.kind !== 'finished') throw new Error(`rehearsal not finished: ${followed.kind}`);
    },
    async join(name, clock) {
      const db = await createTestDatabase<Database>(`reel_${name}`);
      worlds.push(db);
      const mediaRoot = join(root, `media-${name}`);
      await mkdir(mediaRoot, { recursive: true });
      return { name, db, mediaRoot, operator: operatorOn(db, name, mediaRoot, clock) };
    },
    operatorWith: (joined, scripts) => operatorOn(joined.db, joined.name, joined.mediaRoot, undefined, scripts),
    async close() {
      await cutroom.close();
      for (const db of worlds) await db.drop();
      await pool.drop();
    },
  };
}
