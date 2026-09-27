/**
 * #134 — seeds one day-old, backdated history through the real HTTP API for the `places` journey
 * (`scripts/android-semantic-journey.py`): keeps "One force, many jobs" as the single device
 * identity the Android app under test also authenticates as (`KS_DEV_TOKEN`), then backdates its
 * ledger rows by one day -- exactly `tests/atlas-places.test.ts`'s `anchorGravity` helper's first
 * step. The instrumented test then supplies the real second day itself (two more keeps, driven
 * through the actual reader UI), which is what anchors the planet -- this script never forms it.
 *
 * Refuses anything but a disposable `knowscroll_test_*` database and a loopback API base. Imports
 * only `pg` directly (never `packages/db`, whose pool would open a connection as an import side
 * effect before the guard below could run) and the same plain `fetch` calls the app itself makes.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/knowscroll_test_')) {
  throw new Error('seed-day-old-history.ts requires a disposable knowscroll_test_* database');
}
const base = process.env.KS_ATLAS_SEED_API_BASE;
if (!base || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('seed-day-old-history.ts requires a loopback KS_ATLAS_SEED_API_BASE');
}
const token = process.env.KS_DEV_TOKEN;
if (!token) throw new Error('seed-day-old-history.ts requires KS_DEV_TOKEN');

const TITLE_PREFIX = 'One force, many jobs';

type Feed = { decisionId: string; items: { assetId: string; title: string }[] };
type Exposure = { exposureId: string; eventId: string };
type Universe = { universeId: string };

async function api<T>(path: string, init: RequestInit = {}, expected = 200): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== expected) {
    throw new Error(`seed-day-old-history: ${path} expected ${expected}, got ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

async function keepOneForceManyJobs(): Promise<void> {
  const skipped: string[] = [];
  for (let step = 0; step < 30; step += 1) {
    const query = skipped.length ? `?kinds=Scroll&exclude=${skipped.join(',')}` : '?kinds=Scroll';
    const feed = await api<Feed>(`/v1/feed${query}`);
    const target = feed.items.find(item => item.title.startsWith(TITLE_PREFIX));
    if (!target) {
      skipped.push(...feed.items.map(item => item.assetId));
      continue;
    }
    const exposure = await api<Exposure>(
      '/v1/exposures',
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decisionId: feed.decisionId, assetId: target.assetId, clientExposureId: randomUUID() }),
      },
      201,
    );
    await api(
      '/v1/interactions',
      {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientEventId: randomUUID(), exposureId: exposure.exposureId, assetId: target.assetId, kind: 'keep' }),
      },
      202,
    );
    return;
  }
  throw new Error(`seed-day-old-history: the library never offered "${TITLE_PREFIX}"`);
}

const universe = await api<Universe>('/v1/universe');
await keepOneForceManyJobs();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("UPDATE ledger SET created_at = created_at - interval '1 day' WHERE universe_id=$1", [universe.universeId]);
} finally {
  await client.end();
}
console.log(JSON.stringify({ seeded: TITLE_PREFIX, universeId: universe.universeId }));
