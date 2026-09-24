/**
 * #163 — the supplied steps of an Idea Rooms session on the device (ADR-0045). SUPPLIED journey
 * knowledge and history, not editorial:
 *
 *   1. One claim about Gravity that a single labelled journey source both supports and qualifies, so
 *      the room's doubter has something to hold ("Two readings disagree"), and withdrawing that one
 *      source (`scripts/substrate/correct-source.ts --source journey.gravity-doubt`) takes it away
 *      again while the reader is away. Its words are hand-written fixture text.
 *   2. Day one, through the real HTTP API as the device identity (`KS_DEV_TOKEN`): keep "One force,
 *      many jobs" and ask about it, then move that day back by one (`scripts/lib/backdate.ts`) -- the
 *      day-old Ask, as `scripts/atlas/seed-day-old-history.ts` does for a keep. The device supplies
 *      day two itself: two more keeps anchor Gravity, and a second Ask opens its room.
 *
 * Refuses anything but a disposable `knowscroll_test_*` database and a loopback API base, before
 * importing `packages/db` (whose pool connects on import). No model is called.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SubstrateSeed } from '../../packages/contracts/src/semantic.ts';

if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/knowscroll_test_')) {
  throw new Error('seed-day-old-ask.ts requires a disposable knowscroll_test_* database');
}
const base = process.env.KS_ROOM_SEED_API_BASE;
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('seed-day-old-ask.ts requires a loopback KS_ROOM_SEED_API_BASE');
const token = process.env.KS_DEV_TOKEN;
if (!token) throw new Error('seed-day-old-ask.ts requires KS_DEV_TOKEN');

const SOURCE = 'journey.gravity-doubt';
const TITLE_PREFIX = 'One force, many jobs';
const QUESTION = 'Why does everything fall toward the ground?';

const editorial = JSON.parse(readFileSync('content/substrate.json', 'utf8')) as SubstrateSeed;
const seed: SubstrateSeed = {
  version: `${editorial.version}.163`,
  families: [{ key: 'journey.fixture', kind: 'publisher', description: 'Journey fixture knowledge: supplied, not editorial' }],
  sources: [{
    key: SOURCE, url: 'https://example.test/journey/gravity-doubt', title: 'Journey fixture: another reading of gravity', publisher: 'Journey fixture',
    familyKey: 'journey.fixture', retrievedAt: '2026-09-25', contentSha256: createHash('sha256').update('journey fixture: another reading of gravity').digest('hex'),
  }],
  // A seed names every concept it links, exactly as the editorial seed has it.
  concepts: editorial.concepts.filter(c => c.code === 'physics.gravity'),
  claims: [{
    key: 'clm.journey.gravity_curvature', statement: 'Gravity is not a pull at all but the curving of space and time around a mass.', truthState: 'documented',
    concepts: [{ code: 'physics.gravity', role: 'subject' }],
    support: [
      { sourceKey: SOURCE, quote: 'A verbatim passage long enough to be a quote.', supportKind: 'supports' },
      { sourceKey: SOURCE, quote: 'A second verbatim passage that qualifies the first.', supportKind: 'qualifies' },
    ],
  }],
  relations: [],
  assets: [],
  bridgeProposals: [],
};

type Feed = { decisionId: string; items: { assetId: string; title: string }[] };
async function api<T>(path: string, init: RequestInit = {}, expected = 200): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== expected) throw new Error(`seed-day-old-ask: ${path} expected ${expected}, got ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Keeps "One force, many jobs" as the device would, and returns its exposure. */
async function keepOneForceManyJobs(): Promise<string> {
  const skipped: string[] = [];
  for (let step = 0; step < 30; step += 1) {
    const feed = await api<Feed>(`/v1/feed?kinds=Scroll${skipped.length ? `&exclude=${skipped.join(',')}` : ''}`);
    const target = feed.items.find(item => item.title.startsWith(TITLE_PREFIX));
    if (!target) { skipped.push(...feed.items.map(item => item.assetId)); continue; }
    const { exposureId } = await api<{ exposureId: string }>('/v1/exposures', {
      method: 'POST', body: JSON.stringify({ decisionId: feed.decisionId, assetId: target.assetId, clientExposureId: randomUUID() }),
    }, 201);
    await api('/v1/interactions', { method: 'POST', body: JSON.stringify({ clientEventId: randomUUID(), exposureId, assetId: target.assetId, kind: 'keep' }) }, 202);
    return exposureId;
  }
  throw new Error(`seed-day-old-ask: the library never offered "${TITLE_PREFIX}"`);
}

const { pool, transaction } = await import('../../packages/db/src/index.ts');
const { loadSubstrateSeed } = await import('../../packages/db/src/semantic/seed.ts');
const { backdateOneDay } = await import('../lib/backdate.ts');
try {
  const loaded = await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)));
  if (loaded.status !== 'loaded') throw new Error('seed-day-old-ask: the journey knowledge was already loaded');
  const universe = await api<{ universeId: string; privacyEpoch: number }>('/v1/universe');
  const exposureId = await keepOneForceManyJobs();
  await api('/v1/asks', { method: 'POST', body: JSON.stringify({ clientAskId: randomUUID(), exposureId, question: QUESTION, expectedPrivacyEpoch: universe.privacyEpoch }) }, 201);
  await transaction(client => backdateOneDay(client, universe.universeId));
  console.log(JSON.stringify({ seeded: TITLE_PREFIX, asked: QUESTION, source: SOURCE, universeId: universe.universeId, simulated: 'journey knowledge and history supplied, not editorial' }));
} finally {
  await pool.end();
}
