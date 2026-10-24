import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { composeReelOperator } from '@knowscroll/backend/modules/content/nest-providers';
import { createTestDatabase, type TestDatabase } from './database.js';
import { TEST_DATABASE_PREFIX, databaseUrl, quoteIdentifier, withAdmin } from './admin.js';
import { startFakeCutroom, type FakeCutroom, type PostMode } from './fake-cutroom.js';

/** CI has ffprobe at /usr/bin; a Mac usually has it under Homebrew. */
const ffprobePath = ['/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'].find((path) =>
  existsSync(path),
);
const poolMigrations = new URL('../../../ops/pool/migrations/', import.meta.url);

/** A disposable shared pool: the real pool functions on a throwaway database. */
export interface TestPool {
  readonly client: pg.Pool;
  readonly name: string;
  /** Settles `cents` of earlier spend, as v1's orders did, in the pool's own functions. */
  seedSettled(cents: number): Promise<void>;
  /** Applies the cap migration (0005) once the earlier spend is seeded. */
  raiseCap(): Promise<void>;
  budget(): Promise<{ cap_cents: number; committed_cents: number; left_cents: number }>;
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
          'fixture: earlier v1 spend',
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
      return (await client.query('select * from pool_orders()')).rows as Record<string, unknown>[];
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

export interface ReelWorld {
  readonly cutroom: FakeCutroom;
  readonly pool: TestPool;
  readonly root: string;
  /** A world (its database and operator) that orders from the shared fixture Cutroom and pool. */
  join(name: 'dev' | 'stage'): Promise<{
    readonly db: TestDatabase<Database>;
    readonly mediaRoot: string;
    readonly operator: ReturnType<typeof composeReelOperator>;
  }>;
  setPostMode(mode: PostMode): void;
  close(): Promise<void>;
}

/**
 * The fixture world of the Reel tests: one fake Cutroom, one disposable pool at v1's state, and any
 * number of worlds (databases) sharing them, as dev and stage share the real ones.
 */
export async function createReelWorld(
  options: { readonly onPost?: (body: string) => Promise<void> } = {},
): Promise<ReelWorld> {
  // macOS temp folders are symlinks; the media store and artifact reader refuse those.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ks-reel-'));
  const cutroom = await startFakeCutroom(root, options.onPost);
  const pool = await createTestPool();
  const worlds: TestDatabase<Database>[] = [];
  return {
    cutroom,
    pool,
    root,
    setPostMode: cutroom.setPostMode,
    async join(name) {
      const db = await createTestDatabase<Database>(`reel_${name}`);
      worlds.push(db);
      const mediaRoot = join(root, `media-${name}`);
      await mkdir(mediaRoot, { recursive: true });
      const operator = composeReelOperator(db.db, pool.client, {
        world: name,
        cutroomOrigin: cutroom.origin,
        cutroomArtifactRoot: cutroom.artifactRoot,
        mediaRoot,
        ffprobePath,
      });
      return { db, mediaRoot, operator };
    },
    async close() {
      await cutroom.close();
      for (const db of worlds) await db.drop();
      await pool.drop();
    },
  };
}
