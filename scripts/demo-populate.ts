/**
 * demo-populate.ts — fill a disposable universe to a chosen stage so the Cosmos/Living Observatory
 * interface (docs/product/ui-system.md §5b/§5c) can be judged, without waiting on a recommendation
 * engine that does not exist yet (`compose()` in packages/core/src/composer.ts is still only
 * "exclude what is kept, take three" — there is no ranking, no inferred interest, nothing to
 * demonstrate progression with otherwise).
 *
 * ============================================================================================
 * THIS TOOL IS FOR INTERFACE EVALUATION ONLY. IT PROVES NOTHING.
 * A universe it populates is not evidence of a working recommendation algorithm, of real universe
 * evolution, of real usage, or of anything else the product claims for a real reader. It exists so
 * a screen can be looked at with more than zero or three items on it. Every record it writes is
 * marked (see "The demo marker" below) so a screenshot of it can never be mistaken for real runtime
 * evidence, and it refuses outright to run anywhere but a disposable knowscroll_demo_* database.
 * ============================================================================================
 *
 * What it does, and does not do
 * ------------------------------
 * It seeds the real editorial library (content/editorial-scrolls.json, unmarked, exactly as
 * scripts/seed.ts already installs it — real sourced content, not a fabrication) plus an expanded
 * demo library (content/demo-library.json, visibly marked — see below) of additional real, sourced
 * astronomy Scrolls, every one citing a sourceUrl that already appears in
 * content/editorial-scrolls.json. It never invents a source.
 *
 * It then drives Keep/exposure exclusively through the real database contract this product already
 * exposes to a real client: `GET /v1/feed` → `POST /v1/exposures` → `POST /v1/interactions` (kind
 * `keep`) against the real Fastify app (`apps/api/src/app.ts`'s `buildApp`, exercised in-process via
 * Fastify's own `inject`, exactly as `tests/inventory-http.test.ts` already does), followed by the
 * real deterministic projection function the worker process itself runs
 * (`apps/worker/src/project.ts`'s `projectOne`). It never writes a `trace` row, an `accounts` row or
 * a `ledger` row directly — only a state the product's own code path could itself reach.
 *
 * It never touches identity, sign-in, media or reasoning; it never touches Cutroom, upstream or
 * local; and its one required environment variable is `DATABASE_URL`, which it never prints, logs,
 * or otherwise reproduces (a Postgres connection string carries a password).
 *
 * The refusal guard
 * ------------------
 * Before this file imports anything that could open a database connection (`pg`, any module under
 * packages/db), it calls `assertDemoDatabaseName` (scripts/lib/demo-database-guard.ts) against
 * `DATABASE_URL`. A database whose name does not begin `knowscroll_demo_` is refused immediately —
 * this is tested directly, as a pure function with no database involved at all, plus a subprocess
 * smoke test proving no connection is even attempted, in tests/demo-populate-guard.test.ts.
 *
 * The demo marker
 * ----------------
 * Every asset this tool inserts from content/demo-library.json — never the three from
 * content/editorial-scrolls.json, which are real production editorial content and carry no marker —
 * gets:
 *   - its title prefixed with `[DEMO — interface evaluation only]`, so a reader sees it on every
 *     card, stage and reader screen the interface can show it on, and
 *   - its source title suffixed with `· DEMO EVALUATION DATA, NOT REAL USAGE EVIDENCE`.
 * Both are plain text columns, so the same marker that a reader sees is what a query filters on too
 * (`WHERE title LIKE '[DEMO%'`), with no schema change and no new column.
 *
 * Stages
 * ------
 * There are exactly two real states a finite library can be in for one reader (ui-system.md §5c):
 * no kept Traces at all ("first visit"), or at least one ("returning"). This tool's three stages are
 * the same real "returning" mechanism driven to three different real kept-Trace counts, so the
 * universe body count and the finite-library remainder (§5b) can be judged at more than one size:
 *
 *   --stage empty   0 kept Traces   — first-visit state (§5c)
 *   --stage light   3 kept Traces   — an early "day 6"-sized returning universe
 *   --stage full   12 kept Traces   — "roughly a dozen", a "day 30"-sized returning universe
 *
 * This tool never fabricates a date or backdates a `created_at`: every ledger row it produces gets
 * a real timestamp of whenever this tool actually ran, because that is genuinely when the Keep
 * happened. The interface's own age/day badge reads honestly small as a result — the stages differ
 * in real kept-Trace *count*, which is what actually drives the first-visit/returning branch and the
 * body count, not in a simulated calendar.
 *
 * Stages only grow a universe (this tool refuses to run a stage below the database's current kept
 * count, rather than un-keeping something the product itself cannot un-keep).
 *
 * Invocation
 * ----------
 *   export DATABASE_URL="$YOUR_KNOWSCROLL_DEMO_DATABASE_URL"   # must name knowscroll_demo_<anything>
 *   pnpm exec tsx scripts/demo-populate.ts --stage empty
 *   pnpm exec tsx scripts/demo-populate.ts --stage light
 *   pnpm exec tsx scripts/demo-populate.ts --stage full
 *
 * The target database is created (CREATE DATABASE) if it does not already exist, then migrated with
 * the same `runMigrations` the rest of this project uses. Point the web app at the same URL (its own
 * `.env`, or `DATABASE_URL=... pnpm dev:api` in a scratch terminal) to look at what it seeded — never
 * the owner's `.env` or database.
 */
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

import { assertDemoDatabaseName } from './lib/demo-database-guard.ts';

// ------------------------------------------------------------------------------------------------
// 1) The guard. This must run, and must succeed, before anything below imports a database module.
// ------------------------------------------------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL;
const databaseName = assertDemoDatabaseName(databaseUrl);

// ------------------------------------------------------------------------------------------------
// 2) Argument parsing. Kept dependency-free and deliberately strict.
// ------------------------------------------------------------------------------------------------
const STAGE_TARGETS = { empty: 0, light: 3, full: 12 } as const;
type Stage = keyof typeof STAGE_TARGETS;

function usage(): never {
  throw new Error('Usage: DATABASE_URL=postgresql://.../knowscroll_demo_<name> tsx scripts/demo-populate.ts --stage <empty|light|full>');
}

function parseStage(argv: string[]): Stage {
  const index = argv.indexOf('--stage');
  if (index === -1 || argv[index + 1] === undefined) usage();
  const value = argv[index + 1]!;
  if (value !== 'empty' && value !== 'light' && value !== 'full') usage();
  return value;
}

const stage = parseStage(process.argv.slice(2));
const targetKept = STAGE_TARGETS[stage];

// ------------------------------------------------------------------------------------------------
// 3) Ensure the (already-validated) demo database exists. Only now does a connection ever open.
// ------------------------------------------------------------------------------------------------
async function ensureDatabaseExists(url: string, name: string): Promise<void> {
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 10_000 });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    console.log(`Created database ${name}.`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42P04') throw error; // 42P04 = duplicate_database
    console.log(`Database ${name} already exists; reusing it.`);
  } finally {
    await admin.end();
  }
}

await ensureDatabaseExists(databaseUrl!, databaseName);

// process.env.DATABASE_URL is already exactly `databaseUrl` (we never mutate it), so every module
// imported from here on that reads it — including packages/db's own local `.env` fallback, which
// only ever fills in a variable that is still unset — resolves to the same validated demo database.
const { pool, transaction, OWNER_ID } = await import('../packages/db/src/index.ts');
const { runMigrations } = await import('../packages/db/src/migrations.ts');
const { provisionIdentity } = await import('../packages/db/src/identity.ts');
const { buildApp } = await import('../apps/api/src/app.ts');
const { projectOne } = await import('../apps/worker/src/project.ts');

type LibraryAsset = { assetId: string; title: string; summary: string; body: string; sourceTitle: string; sourceUrl: string };

const DEMO_TITLE_PREFIX = '[DEMO — interface evaluation only]';
const DEMO_SOURCE_SUFFIX = '· DEMO EVALUATION DATA, NOT REAL USAGE EVIDENCE';

async function loadLibrary(path: string): Promise<LibraryAsset[]> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as LibraryAsset[];
}

async function seedLibrary(): Promise<number> {
  const base = await loadLibrary('content/editorial-scrolls.json');
  const demo = await loadLibrary('content/demo-library.json');
  return transaction(async client => {
    await client.query('INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);
    await client.query('INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);
    for (const [i, a] of base.entries()) {
      await client.query(
        `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
         VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7) ON CONFLICT(id) DO NOTHING`,
        [a.assetId, a.title, a.summary, a.body, a.sourceTitle, a.sourceUrl, i],
      );
    }
    for (const [i, a] of demo.entries()) {
      await client.query(
        `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
         VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7) ON CONFLICT(id) DO NOTHING`,
        [
          a.assetId,
          `${DEMO_TITLE_PREFIX} ${a.title}`,
          a.summary,
          a.body,
          `${a.sourceTitle} ${DEMO_SOURCE_SUFFIX}`,
          a.sourceUrl,
          1000 + i, // disjoint from the base library's editorial_order range
        ],
      );
    }
    return base.length + demo.length;
  });
}

async function currentKeptCount(): Promise<number> {
  const row = (await pool.query('SELECT kept_asset_ids FROM accounts WHERE universe_id=$1', [OWNER_ID])).rows[0];
  return (row?.kept_asset_ids ?? []).length;
}

/** Drives exactly one real Keep to completion: feed → exposure → interaction → deterministic
 * projection, all through the app's own routes and the worker's own projection function — the same
 * path tests/inventory-http.test.ts already proves against production code. */
async function keepOneMore(app: Awaited<ReturnType<typeof buildApp>>, token: string): Promise<string> {
  const feed = await app.inject({ url: '/v1/feed', headers: { authorization: `Bearer ${token}` } });
  if (feed.statusCode !== 200) throw new Error(`GET /v1/feed failed: ${feed.statusCode} ${feed.body}`);
  const feedBody = feed.json() as { decisionId: string; items: Array<{ assetId: string; title: string }> };
  const item = feedBody.items[0];
  if (!item) throw new Error('Editorial library exhausted: no unkept Scroll remains to reach the requested stage.');

  const exposure = await app.inject({
    method: 'POST', url: '/v1/exposures', headers: { authorization: `Bearer ${token}` },
    payload: { decisionId: feedBody.decisionId, assetId: item.assetId, clientExposureId: randomUUID() },
  });
  if (exposure.statusCode !== 201) throw new Error(`POST /v1/exposures failed: ${exposure.statusCode} ${exposure.body}`);

  const keep = await app.inject({
    method: 'POST', url: '/v1/interactions', headers: { authorization: `Bearer ${token}` },
    payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId: item.assetId, kind: 'keep' },
  });
  if (keep.statusCode !== 202) throw new Error(`POST /v1/interactions failed: ${keep.statusCode} ${keep.body}`);
  const jobId = keep.json().jobId as string;

  let projected = false;
  for (let i = 0; i < 64; i += 1) {
    const result = await projectOne();
    if (result?.jobId === jobId) { projected = true; break; }
    if (!result) break;
  }
  if (!projected) throw new Error(`Keep of ${item.assetId} was accepted but never projected (jobId ${jobId}).`);
  return item.title;
}

try {
  await runMigrations(pool, { directory: resolve('packages/db/migrations') });
  const totalAssets = await seedLibrary();
  const before = await currentKeptCount();
  if (targetKept < before) {
    throw new Error(
      `Stage "${stage}" wants ${targetKept} kept Traces, but this database already has ${before}. ` +
      'This tool only grows a universe forward through the real contract; it will never un-keep ' +
      'something the product itself cannot un-keep. Start from a fresh knowscroll_demo_* database instead.',
    );
  }
  const toAdd = targetKept - before;
  let added: string[] = [];
  if (toAdd > 0) {
    const app = buildApp(randomBytes(32).toString('hex'));
    await app.ready();
    try {
      const identity = await provisionIdentity({ universeId: OWNER_ID });
      for (let i = 0; i < toAdd; i += 1) added.push(await keepOneMore(app, identity.token));
    } finally {
      await app.close();
    }
  }
  console.log(JSON.stringify({
    database: databaseName,
    stage,
    editorialAssetsSeeded: totalAssets,
    keptBefore: before,
    keptAfter: before + added.length,
    newlyKept: added,
    note: 'Interface evaluation data only. Proves nothing about the recommendation algorithm, universe evolution, or real usage.',
  }, null, 2));
} finally {
  await pool.end();
}
