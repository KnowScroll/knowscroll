/**
 * #131/#134 — the one simulated step of the `foundation` journey (`scripts/android-semantic-journey.py`):
 * places for Tides, Orbit and Star formation, formed by the real Cartographer from accounts this
 * script supplies instead of from reading. The editorial library cannot anchor Orbit or Star
 * formation today (each has Scrolls from one source family only), so no reading could produce them.
 * The injected accounts carry zero episodes, days and marks and cite no episode, so the evidence of
 * each of these places says plainly that no reading formed it.
 *
 * Gravity is NOT seeded here: the device reads its way to it (with `seed-day-old-history.ts`'s
 * day-old keep), and the refresh that forms it is the one that recognises it as a foundation.
 *
 * Refuses anything but a disposable `knowscroll_test_*` database and a loopback API base, before
 * importing `packages/db` (whose pool connects on import).
 */
if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/knowscroll_test_')) {
  throw new Error('seed-held-up-places.ts requires a disposable knowscroll_test_* database');
}
const base = process.env.KS_ATLAS_SEED_API_BASE;
if (!base || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('seed-held-up-places.ts requires a loopback KS_ATLAS_SEED_API_BASE');
}
const token = process.env.KS_DEV_TOKEN;
if (!token) throw new Error('seed-held-up-places.ts requires KS_DEV_TOKEN');

const HELD_UP = ['earth.tides', 'astro.orbit', 'astro.star.birth'];

const response = await fetch(`${base}/v1/universe`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
if (response.status !== 200) throw new Error(`seed-held-up-places: /v1/universe returned ${response.status}`);
const { universeId } = (await response.json()) as { universeId: string };

const { pool, transaction } = await import('../../packages/db/src/index.ts');
const { runCartographer } = await import('../../packages/db/src/atlas.ts');
try {
  const deltas = await transaction(async client => {
    await client.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [universeId]);
    return runCartographer(client, universeId, HELD_UP.map(concept => ({
      concept, state: 'anchored' as const, episodes: 0, daysActive: 0, voluntary: 0, sourceFamilies: 0, mass: 0,
      evidence: { episodeIds: [], markIds: [] },
    })));
  });
  console.log(JSON.stringify({ seededPlaces: HELD_UP, deltas, universeId, simulated: 'accounts supplied, not read' }));
} finally {
  await pool.end();
}
