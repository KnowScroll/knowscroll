/**
 * demo-populate.ts — fill a disposable universe with real, honest exposures so the system view
 * (#116, ADR-0028/#113) can be looked at with more than an empty state. Re-created for this lane
 * from the (unmerged, pre-#113) demo populator on branch `claude/112-web-cosmos`; that version
 * depended on files this lane does not have (`content/demo-library.json`,
 * `scripts/lib/demo-database-guard.ts`) and drove Keep through the worker's own projection to
 * reach a Trace count -- worlds/systems project on exposure alone (`POST /v1/exposures` itself
 * calls `projectWorldsForEncounter`, ADR-0028), so this rewrite only needs the real feed/exposure
 * contract, not a Keep or a worker process at all.
 *
 * ============================================================================================
 * THIS TOOL IS FOR INTERFACE EVALUATION ONLY. IT PROVES NOTHING.
 * A universe it populates is not evidence of a working recommendation algorithm, of real usage, or
 * of anything else the product claims for a real reader/owner. It exists so the system view can be
 * screenshotted against something other than the honest empty state. It never invents a source: it
 * seeds exactly the real, unmarked editorial library (`content/editorial-scrolls.json`, the same
 * three Scrolls `scripts/seed.ts` installs) and drives real `GET /v1/feed` -> `POST /v1/exposures`
 * calls against the real Fastify app (`apps/api/src/app.ts`'s `buildApp`, exercised in-process via
 * Fastify's own `inject`). It refuses outright to run anywhere but a disposable
 * `knowscroll_demo_*` database.
 * ============================================================================================
 *
 * What it does, and does not do
 * ------------------------------
 * It exposes (never Keeps) two of the library's three Scrolls: both of its `NASA · Stars` Scrolls
 * would over-claim, so instead it exposes the source's *one* Stars Scroll (fully reached: 1 of 1)
 * and only *one* of the two `NASA · Orbits and Kepler's Laws` Scrolls (partially reached: 1 of 2) --
 * so the system view's two real states (fully explored / more to explore) are both real, not staged.
 * It never writes a `world`, `world_system`, `exposure` or `ledger` row directly; every row comes
 * from the same HTTP contract a real client uses. It never touches identity beyond
 * `provisionIdentity` (the same in-process helper `tests/*.test.ts` already use), and never
 * touches Cutroom, media or reasoning. Its one required environment variable is `DATABASE_URL`,
 * which it never prints, logs, or otherwise reproduces (a Postgres connection string carries a
 * password) -- read only into this process's own environment, as AGENTS.md requires.
 *
 * Invocation
 * ----------
 *   DATABASE_URL="postgresql://.../knowscroll_demo_<anything>" pnpm exec tsx scripts/demo-populate.ts
 *
 * The target database is created (CREATE DATABASE) if it does not already exist, then migrated
 * with the same `runMigrations` the rest of this project uses.
 */
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

// ------------------------------------------------------------------------------------------------
// 1) The guard. This must run, and must succeed, before anything below imports a database module.
// ------------------------------------------------------------------------------------------------
function assertDemoDatabaseName(rawUrl: string | undefined): { url: string; name: string } {
  if (!rawUrl) throw new Error('DATABASE_URL is required, naming a knowscroll_demo_* database.');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL.');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error('This tool only permits a loopback PostgreSQL server.');
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (!name.startsWith('knowscroll_demo_')) {
    throw new Error(`Refusing to run against database "${name}": its name must start with "knowscroll_demo_".`);
  }
  return { url: rawUrl, name };
}

const { url: databaseUrl, name: databaseName } = assertDemoDatabaseName(process.env.DATABASE_URL);

// ------------------------------------------------------------------------------------------------
// 2) Ensure the (already-validated) demo database exists. Only now does a connection ever open.
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

await ensureDatabaseExists(databaseUrl, databaseName);

// process.env.DATABASE_URL is already exactly `databaseUrl` (never mutated here), so every module
// imported from here on -- including packages/db's own local `.env` fallback, which only ever
// fills in a variable that is still unset -- resolves to this same validated demo database.
const { pool, transaction, OWNER_ID } = await import('../packages/db/src/index.ts');
const { runMigrations } = await import('../packages/db/src/migrations.ts');
const { provisionIdentity } = await import('../packages/db/src/identity.ts');
const { buildApp } = await import('../apps/api/src/app.ts');

type LibraryAsset = { assetId: string; title: string; summary: string; body: string; sourceTitle: string; sourceUrl: string };

async function seedEditorialLibrary(): Promise<LibraryAsset[]> {
  const assets = JSON.parse(await readFile(resolve('content/editorial-scrolls.json'), 'utf8')) as LibraryAsset[];
  await transaction(async client => {
    await client.query('INSERT INTO universe(id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);
    await client.query('INSERT INTO accounts(universe_id) VALUES($1) ON CONFLICT DO NOTHING', [OWNER_ID]);
    for (const [i, a] of assets.entries()) {
      await client.query(
        `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
         VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7) ON CONFLICT(id) DO NOTHING`,
        [a.assetId, a.title, a.summary, a.body, a.sourceTitle, a.sourceUrl, i],
      );
    }
  });
  return assets;
}

/** Drives one real exposure to completion via the app's own routes -- the same path
 * `tests/inventory-http.test.ts` and friends already exercise against production code. */
async function exposeAsset(app: Awaited<ReturnType<typeof buildApp>>, token: string, decisionId: string, assetId: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/exposures',
    headers: { authorization: `Bearer ${token}` },
    payload: { decisionId, assetId, clientExposureId: randomUUID() },
  });
  if (response.statusCode !== 201) throw new Error(`POST /v1/exposures failed for ${assetId}: ${response.statusCode} ${response.body}`);
}

try {
  await runMigrations(pool, { directory: resolve('packages/db/migrations') });
  const assets = await seedEditorialLibrary();

  const orbits = assets.filter(a => a.sourceTitle.startsWith('NASA · Orbits'));
  const stars = assets.filter(a => a.sourceTitle.startsWith('NASA · Stars'));
  if (orbits.length < 2 || stars.length < 1) {
    throw new Error('content/editorial-scrolls.json no longer has the expected two-source shape this tool relies on.');
  }

  const app = buildApp(randomBytes(32).toString('hex'));
  await app.ready();
  let exposed: string[] = [];
  try {
    const identity = await provisionIdentity({ universeId: OWNER_ID });
    const feed = await app.inject({ url: '/v1/feed', headers: { authorization: `Bearer ${identity.token}` } });
    if (feed.statusCode !== 200) throw new Error(`GET /v1/feed failed: ${feed.statusCode} ${feed.body}`);
    const feedBody = feed.json() as { decisionId: string; items: Array<{ assetId: string; title: string }> };

    // Fully reached: this source's one Scroll. Partially reached: only one of the two Orbits
    // Scrolls -- both real distinctions the system view actually draws, not staged for effect.
    const toExpose = [stars[0]!, orbits[0]!];
    for (const asset of toExpose) {
      const inFeed = feedBody.items.some(item => item.assetId === asset.assetId);
      if (!inFeed) throw new Error(`Expected asset ${asset.assetId} in the feed's own decision candidates.`);
      await exposeAsset(app, identity.token, feedBody.decisionId, asset.assetId);
      exposed.push(asset.title);
    }
  } finally {
    await app.close();
  }

  console.log(
    JSON.stringify(
      {
        database: databaseName,
        editorialAssetsSeeded: assets.length,
        exposed,
        note: 'Interface evaluation data only. Proves nothing about a recommendation algorithm, universe evolution, or real usage.',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
