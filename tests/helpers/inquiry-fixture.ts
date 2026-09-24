/**
 * #132 — a unique substrate for background inquiry tests (ADR-0038), plus the reader-side helpers.
 * Knowledge rows are global and immutable, so each call mints its own codes/keys (`i<tag>…`), its own
 * sources (one per side, so a correction can take exactly one side's claim away) and its own Scrolls.
 *
 * Shape: Gravity and the Sun are connected only by a claim naming both (a candidate pair); Gravity
 * explains Tides (an active relation, so that pair is never offered); Body has claims but nothing
 * naming it with anything else.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SubstrateSeed } from '../../packages/contracts/src/semantic.ts';
import { transaction } from '../../packages/db/src/index.ts';
import { runCartographer } from '../../packages/db/src/atlas.ts';
import { loadSubstrateSeed } from '../../packages/db/src/semantic/seed.ts';

export type InquiryFixture = {
  tag: string;
  codes: Record<'gravity' | 'sun' | 'tides' | 'body', string>;
  claims: Record<'gravity' | 'sun' | 'both' | 'tides' | 'gravityTides' | 'body', string>;
  sources: Record<'physics' | 'stars' | 'bridge' | 'biology', string>;
  assets: { gravity: string; sun: string };
};

async function insertScroll(client: pg.Pool | pg.PoolClient, title: string, sourceTitle: string, sourceUrl: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [id, title, `Summary of ${title}`, `Body of ${title}.`, sourceTitle, sourceUrl],
  );
  return id;
}

export async function loadInquiryFixture(pool: pg.Pool): Promise<InquiryFixture> {
  const tag = `i${randomBytes(5).toString('hex')}`;
  const c = (s: string) => `${tag}.${s}`;
  const k = (s: string) => `clm.${tag}.${s}`;
  const codes = { gravity: c('gravity'), sun: c('sun'), tides: c('tides'), body: c('body') };
  const claims = { gravity: k('gravity_attraction'), sun: k('sun_star'), both: k('sun_holds'), tides: k('tides_cycle'), gravityTides: k('gravity_tides'), body: k('body_stable') };
  const sources = { physics: `src.${tag}.physics`, stars: `src.${tag}.stars`, bridge: `src.${tag}.bridge`, biology: `src.${tag}.biology` };
  const url = (s: string) => `https://example.test/${tag}/${s}`;
  const assets = {
    gravity: await insertScroll(pool, `${tag} Gravity pulls`, 'Physics fixture', url('physics')),
    sun: await insertScroll(pool, `${tag} Our own star`, 'Stars fixture', url('stars')),
  };
  const quote = 'A verbatim passage long enough to be a quote.';
  const support = (sourceKey: string) => [{ sourceKey, quote, supportKind: 'supports' as const }];
  const hash = () => randomBytes(32).toString('hex');
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-24.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [{ key: `fam.${tag}`, kind: 'publisher', description: 'Synthetic inquiry test family' }],
    sources: (['physics', 'stars', 'bridge', 'biology'] as const).map(s => ({
      key: sources[s], url: url(s), title: `${s[0]!.toUpperCase()}${s.slice(1)} fixture`, publisher: 'Fixture', familyKey: `fam.${tag}`, retrievedAt: '2026-09-24', contentSha256: hash(),
    })),
    concepts: [
      { code: tag, name: 'Inquiry fixture root', description: 'Root of a synthetic inquiry test substrate', kind: 'idea', parentCode: null },
      { code: codes.gravity, name: 'Gravity', description: 'The attraction between masses', kind: 'phenomenon', parentCode: tag },
      { code: codes.sun, name: 'The Sun', description: 'The star at the centre of the solar system', kind: 'object', parentCode: tag },
      { code: codes.tides, name: 'Tides', description: 'The regular rise and fall of the sea', kind: 'phenomenon', parentCode: tag },
      { code: codes.body, name: 'Body', description: 'A living organism keeping itself steady', kind: 'object', parentCode: tag },
    ],
    claims: [
      { key: claims.gravity, statement: 'Every mass attracts every other mass through gravity.', truthState: 'documented', concepts: [{ code: codes.gravity, role: 'subject' }], support: support(sources.physics) },
      { key: claims.sun, statement: 'The Sun is an ordinary star made mostly of hydrogen and helium.', truthState: 'documented', concepts: [{ code: codes.sun, role: 'subject' }], support: support(sources.stars) },
      { key: claims.both, statement: 'The Sun holds the planets in their orbits through its gravity.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'mechanism' }, { code: codes.sun, role: 'subject' }], support: support(sources.bridge) },
      { key: claims.tides, statement: 'Most coasts see two high and two low tides each day.', truthState: 'documented', concepts: [{ code: codes.tides, role: 'subject' }], support: support(sources.physics) },
      { key: claims.gravityTides, statement: 'The pull of the Moon and Sun on the oceans causes the tides.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'mechanism' }, { code: codes.tides, role: 'subject' }], support: support(sources.physics) },
      { key: claims.body, statement: 'A body keeps its internal conditions within a stable range.', truthState: 'documented', concepts: [{ code: codes.body, role: 'subject' }], support: support(sources.biology) },
    ],
    relations: [{ from: codes.gravity, to: codes.tides, kind: 'explains', claimKey: claims.gravityTides }],
    assets: [
      { assetId: assets.gravity, concepts: [{ code: codes.gravity, role: 'primary' }], claims: [claims.gravity] },
      { assetId: assets.sun, concepts: [{ code: codes.sun, role: 'primary' }], claims: [claims.sun] },
    ],
    bridgeProposals: [],
  };
  const loaded = await transaction(client => loadSubstrateSeed(client, JSON.stringify(seed)));
  if (loaded.status !== 'loaded') throw new Error('inquiry fixture substrate did not load');
  return { tag, codes, claims, sources, assets };
}

/** A valid bridge between Gravity and the Sun, as a person might propose it in their own universe. */
export function gravitySunPayload(f: InquiryFixture) {
  return {
    fromConcept: f.codes.gravity, toConcept: f.codes.sun, relationType: 'compares_mechanism' as const,
    mechanism: 'The Sun keeps every planet on a closed path because its gravity bends each one toward it throughout the year.',
    prerequisites: [{ statement: 'Masses attract one another' }],
    limitations: [{ kind: 'analogy_limit' as const, statement: 'The comparison holds for the solar system only' }],
    evidence: [{ claimKey: f.claims.gravity, supports: 'from' as const }, { claimKey: f.claims.sun, supports: 'to' as const }, { claimKey: f.claims.both, supports: 'mechanism' as const }],
    counterevidence: { disposition: 'searched_none_found' as const, searchedScope: 'fixture substrate', claimKeys: [] },
  };
}

const anchored = (concept: string) => ({ concept, state: 'anchored' as const, episodes: 3, daysActive: 2, voluntary: 2, sourceFamilies: 2, mass: 1, evidence: { episodeIds: [], markIds: [] } });

/** The Cartographer forms places from anchored accounts (ADR-0036), under the universe lock, exactly
 * as a personal-model refresh would; every earlier anchor is passed again so nothing else changes. */
export async function formPlaces(universeId: string, codes: string[], earlier: string[] = []): Promise<number> {
  return transaction(async client => {
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE', [universeId]);
    return runCartographer(client, universeId, [...earlier, ...codes].map(anchored));
  });
}
