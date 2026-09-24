/**
 * #132 — the supplied steps of the `inquiry` journey (`scripts/android-semantic-journey.py`,
 * KS_SEMANTIC_JOURNEY=inquiry), ADR-0038. Everything here is SUPPLIED, not read:
 *
 *  1. One background inquiry route, installed and enabled, with the labelled FIXTURE transport
 *     (`apps/worker/src/providers/inquiry-fixture.ts`; the runner starts its worker with
 *     KS_INQUIRY_TRANSPORT=fixture) and a short coalescing delay (KS_INQUIRY_COALESCING_SECONDS,
 *     default 3), so a device run waits seconds, not minutes. No provider is ever called.
 *  2. A place for The Sun (`astro.sun`), formed by the real Cartographer from an account this script
 *     supplies instead of from reading: both of the library's Sun Scrolls come from one source family,
 *     so no reading could anchor it. The account carries zero episodes, days and marks and cites no
 *     episode, so the place's own evidence says plainly that no reading formed it. It is placed
 *     BEFORE the device turns consent on, so it mails nothing (ADR-0038 §1: consent never backfills).
 *
 * Gravity is NOT placed here: the device turns consent on, then reads its way to Gravity (with
 * `scripts/atlas/seed-day-old-history.ts`'s day-old keep), and that place_formed is what mails the
 * inquiry. (The Sun, Gravity) is then the one candidate pair; `tests/inquiry-journey-editorial.test.ts`
 * proves on the same substrate that the fixture's proposal for it is admitted.
 *
 * Refuses anything but a disposable `knowscroll_test_*` database and a loopback API base, before
 * importing `packages/db` (whose pool connects on import).
 */
if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/knowscroll_test_')) {
  throw new Error('seed-journey.ts requires a disposable knowscroll_test_* database');
}
const base = process.env.KS_ATLAS_SEED_API_BASE;
if (!base || new URL(base).hostname !== '127.0.0.1') {
  throw new Error('seed-journey.ts requires a loopback KS_ATLAS_SEED_API_BASE');
}
const token = process.env.KS_DEV_TOKEN;
if (!token) throw new Error('seed-journey.ts requires KS_DEV_TOKEN');
const delay = Number(process.env.KS_INQUIRY_COALESCING_SECONDS ?? 3);
if (!Number.isInteger(delay) || delay < 0 || delay > 60) throw new Error('KS_INQUIRY_COALESCING_SECONDS must be 0..60');

const SUPPLIED = ['astro.sun'];
const POLICY = 'journey-inquiries-fixture-v1';

const response = await fetch(`${base}/v1/universe`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
if (response.status !== 200) throw new Error(`seed-journey: /v1/universe returned ${response.status}`);
const { universeId } = (await response.json()) as { universeId: string };

const { pool, transaction } = await import('../../packages/db/src/index.ts');
const { runCartographer } = await import('../../packages/db/src/atlas.ts');
const { answerFairnessPolicy } = await import('../../packages/db/src/reasoning-answers.ts');
const { createReasoningFairness } = await import('../../packages/db/src/reasoning-fairness.ts');
const { inquiryAuthority, installBackgroundInquiryRoute } = await import('../../packages/db/src/reasoning-inquiries.ts');
try {
  await createReasoningFairness(pool, inquiryAuthority()).installPolicy(answerFairnessPolicy(POLICY, { maxInputTokens: 16384, maxOutputTokens: 2048 }));
  await transaction(client => installBackgroundInquiryRoute(client, {
    policyVersion: POLICY, routeId: 'fixture-inquiries', routeProfileVersion: 'fixture-v1', transport: 'fixture', model: 'fixture-model',
    maxInputTokens: 16384, maxOutputTokens: 2048, requestCap: 4, tokenBudget: 1_000_000, ownerCapacity: 1_000_000, jobCapacity: 100_000,
    coalescingDelaySeconds: delay, jobTtlSeconds: 600, remoteSlots: 1,
  }));
  const consent = (await pool.query('SELECT 1 FROM background_inquiry_consent WHERE universe_id=$1 AND enabled', [universeId])).rowCount;
  if (consent) throw new Error('seed-journey: consent is already on; the supplied place would be mailed');
  const deltas = await transaction(async client => {
    await client.query('SELECT 1 FROM universe WHERE id=$1 FOR UPDATE', [universeId]);
    return runCartographer(client, universeId, SUPPLIED.map(concept => ({
      concept, state: 'anchored' as const, episodes: 0, daysActive: 0, voluntary: 0, sourceFamilies: 0, mass: 0,
      evidence: { episodeIds: [], markIds: [] },
    })));
  });
  const mailed = Number((await pool.query('SELECT count(*) FROM inquiry_mail WHERE universe_id=$1', [universeId])).rows[0].count);
  if (mailed !== 0) throw new Error('seed-journey: the supplied place mailed an inquiry');
  console.log(JSON.stringify({ route: POLICY, transport: 'fixture', coalescingDelaySeconds: delay, seededPlaces: SUPPLIED, deltas, universeId,
    simulated: 'route installed and accounts supplied, not read' }));
} finally {
  await pool.end();
}
