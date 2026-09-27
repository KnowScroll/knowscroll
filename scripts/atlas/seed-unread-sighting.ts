/**
 * #160 — the supplied step of the `return` journey (`scripts/android-semantic-journey.py`,
 * KS_SEMANTIC_JOURNEY=return), ADR-0040. SUPPLIED journey knowledge, not editorial: one concept,
 * "Solar wind", one claim about it and one relation from The Sun, all resting on a single labelled
 * journey source. No Scroll is about it, so the device's reading can never meet it (the walk to
 * Gravity meets every editorial neighbour of Gravity and The Sun); it is on The Sun's horizon from the
 * moment The Sun is placed. The claim names The Sun only as context, so the background inquiry
 * between The Sun and Gravity is offered exactly what it would be offered without it.
 *
 * While the app is away the runner withdraws that source; the worker's catch-up (ADR-0040) then
 * retires the sighting as a `source_correction`, and the return shows it.
 *
 * Refuses anything but a disposable `knowscroll_test_*` database, before importing `packages/db`
 * (whose pool connects on import). Run before `scripts/inquiries/seed-journey.ts` places The Sun.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SubstrateSeed } from '../../packages/contracts/src/semantic.ts';

if (!new URL(process.env.DATABASE_URL ?? '').pathname.startsWith('/knowscroll_test_')) {
  throw new Error('seed-unread-sighting.ts requires a disposable knowscroll_test_* database');
}

const SOURCE = 'journey.solar-wind';
const SIGHTING = 'journey.solar_wind';
// A seed names every concept it links, so The Sun and its ancestors come exactly as the editorial seed has them.
const editorial = JSON.parse(readFileSync('content/substrate.json', 'utf8')) as SubstrateSeed;
const byCode = new Map(editorial.concepts.map(c => [c.code, c]));
const sunAndAncestors: SubstrateSeed['concepts'] = [];
for (let code: string | null = 'astro.sun'; code !== null; code = byCode.get(code)!.parentCode) sunAndAncestors.push(byCode.get(code)!);

const seed: SubstrateSeed = {
  version: `${editorial.version}.160`,
  families: [{ key: 'journey.fixture', kind: 'publisher', description: 'Journey fixture knowledge: supplied, not editorial' }],
  sources: [{
    key: SOURCE, url: 'https://example.test/journey/solar-wind', title: 'Journey fixture: the solar wind', publisher: 'Journey fixture',
    familyKey: 'journey.fixture', retrievedAt: '2026-09-24', contentSha256: createHash('sha256').update('journey fixture: the solar wind').digest('hex'),
  }],
  concepts: [...sunAndAncestors, { code: SIGHTING, name: 'Solar wind', description: 'The stream of charged particles flowing out from the Sun', kind: 'phenomenon', parentCode: null }],
  claims: [{
    key: 'clm.journey.solar_wind', statement: 'The solar wind is a stream of charged particles flowing outward through the solar system.', truthState: 'documented',
    concepts: [{ code: SIGHTING, role: 'subject' }, { code: 'astro.sun', role: 'context' }],
    support: [{ sourceKey: SOURCE, quote: 'A verbatim passage long enough to be a quote.', supportKind: 'supports' }],
  }],
  relations: [{ from: 'astro.sun', to: SIGHTING, kind: 'explains', claimKey: 'clm.journey.solar_wind' }],
  assets: [],
  bridgeProposals: [],
};

const { pool, transaction } = await import('../../packages/db/src/index.ts');
const { loadSubstrateSeed } = await import('../../packages/db/src/semantic/seed.ts');
try {
  const loaded = await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)));
  if (loaded.status !== 'loaded') throw new Error('seed-unread-sighting: the journey knowledge was already loaded');
  console.log(JSON.stringify({ seeded: SIGHTING, source: SOURCE, version: loaded.version, simulated: 'journey knowledge supplied, not editorial' }));
} finally {
  await pool.end();
}
