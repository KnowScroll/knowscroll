/**
 * #164 — a unique, self-contained substrate a reader can exhaust by real reading (ADR-0046). Knowledge
 * rows are global and immutable, so every call mints its own codes, keys and Scrolls (`i<tag>…`).
 *
 * Shape: a root with two concepts, Tides and Gravity. Three Tides Scrolls from two source families
 * (a reader who keeps all three on two days anchors Tides: a planet whose subtree they have then
 * read in full) and one Gravity Scroll; gravity explains tides (an admitted shared bridge, so a
 * Gravity Scroll offers a continuation into Tides). Allowlisted material pages for new Tides Scrolls
 * are hand-written fixtures served by a mocked network, never fetched.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { buildApp } from '../../apps/api/src/app.ts';
import type { SubstrateSeed } from '../../packages/contracts/src/semantic.ts';
import { pool, transaction } from '../../packages/db/src/index.ts';
import { loadSubstrateSeed } from '../../packages/db/src/semantic/seed.ts';
import { readScroll } from './reading.ts';

export type InventoryFixture = {
  tag: string;
  codes: { root: string; tides: string; gravity: string };
  scrolls: { tides: [string, string, string]; gravity: string };
  bridgeId: string;
  /** An allowlisted material URL for a new Scroll about Tides; `page` serves its hand-written text. */
  material: (name: string) => string;
};

const hash = () => randomBytes(32).toString('hex');

async function insertScroll(title: string, sourceTitle: string, sourceUrl: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [id, title, `Summary of ${title}`, `Body of ${title}.`, sourceTitle, sourceUrl],
  );
  return id;
}

export async function makeInventoryFixture(): Promise<InventoryFixture> {
  const tag = `i${randomBytes(5).toString('hex')}`;
  const codes = { root: tag, tides: `${tag}.tides`, gravity: `${tag}.gravity` };
  const url = (s: string) => `https://example.test/${tag}/${s}`;
  const k = (s: string) => `clm.${tag}.${s}`;
  const scrolls = {
    tides: [
      await insertScroll(`${tag} The sea rises twice`, 'Ocean fixture', url('ocean')),
      await insertScroll(`${tag} Two bulges of water`, 'Coast fixture', url('coast')),
      await insertScroll(`${tag} Spring and neap`, 'Ocean fixture', url('ocean')),
    ] as [string, string, string],
    gravity: await insertScroll(`${tag} Every mass pulls`, 'Ocean fixture', url('ocean')),
  };
  const quote = 'A verbatim passage long enough to be a quote.';
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-25.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [
      { key: `fam.${tag}.ocean`, kind: 'publisher', description: 'Synthetic test publisher family' },
      { key: `fam.${tag}.coast`, kind: 'publisher', description: 'A second synthetic publisher family' },
    ],
    sources: [
      { key: `src.${tag}.ocean`, url: url('ocean'), title: 'Ocean fixture', publisher: 'Fixture', familyKey: `fam.${tag}.ocean`, retrievedAt: '2026-09-25', contentSha256: hash() },
      { key: `src.${tag}.coast`, url: url('coast'), title: 'Coast fixture', publisher: 'Fixture', familyKey: `fam.${tag}.coast`, retrievedAt: '2026-09-25', contentSha256: hash() },
    ],
    concepts: [
      { code: codes.root, name: 'Inventory root', description: 'Root of a synthetic test substrate', kind: 'idea', parentCode: null },
      { code: codes.tides, name: 'Tides', description: 'The regular rise and fall of the sea', kind: 'phenomenon', parentCode: codes.root },
      { code: codes.gravity, name: 'Gravity', description: 'The attraction between masses', kind: 'phenomenon', parentCode: codes.root },
    ],
    claims: [
      { key: k('rise'), statement: 'The sea at most coasts rises and falls twice a day.', truthState: 'documented',
        concepts: [{ code: codes.tides, role: 'subject' }], support: [{ sourceKey: `src.${tag}.ocean`, quote, supportKind: 'supports' }] },
      { key: k('bulges'), statement: 'The oceans bulge on the sides of Earth facing and facing away from the Moon.', truthState: 'documented',
        concepts: [{ code: codes.tides, role: 'subject' }], support: [{ sourceKey: `src.${tag}.coast`, quote, supportKind: 'supports' }] },
      { key: k('spring'), statement: 'Tides are largest when the Sun and the Moon line up.', truthState: 'documented',
        concepts: [{ code: codes.tides, role: 'subject' }], support: [{ sourceKey: `src.${tag}.ocean`, quote, supportKind: 'supports' }] },
      { key: k('pull'), statement: 'Every mass attracts every other mass through gravity.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'subject' }], support: [{ sourceKey: `src.${tag}.ocean`, quote, supportKind: 'supports' }] },
      { key: k('gravity_tides'), statement: 'The Moon\'s gravity pulls on the oceans and causes the tides.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'mechanism' }, { code: codes.tides, role: 'subject' }], support: [{ sourceKey: `src.${tag}.ocean`, quote, supportKind: 'supports' }] },
    ],
    relations: [{ from: codes.gravity, to: codes.tides, kind: 'explains', claimKey: k('gravity_tides') }],
    assets: [
      { assetId: scrolls.tides[0], concepts: [{ code: codes.tides, role: 'primary' }], claims: [k('rise')] },
      { assetId: scrolls.tides[1], concepts: [{ code: codes.tides, role: 'primary' }], claims: [k('bulges')] },
      { assetId: scrolls.tides[2], concepts: [{ code: codes.tides, role: 'primary' }], claims: [k('spring')] },
      { assetId: scrolls.gravity, concepts: [{ code: codes.gravity, role: 'primary' }], claims: [k('pull'), k('gravity_tides')] },
    ],
    bridgeProposals: [{ key: `brg.${tag}.gravity_tides`, payload: {
      fromConcept: codes.gravity, toConcept: codes.tides, relationType: 'explains',
      mechanism: 'The Moon pulls on Earth\'s oceans with gravity; the water nearest it is pulled most, so it bulges, and each coast passes through the bulges as Earth turns.',
      prerequisites: [{ statement: 'Masses attract one another through gravity' }],
      limitations: [{ kind: 'scope_limit', statement: 'Coastline shape changes the timing and height of local tides' }],
      evidence: [{ claimKey: k('pull'), supports: 'from' }, { claimKey: k('rise'), supports: 'to' }, { claimKey: k('gravity_tides'), supports: 'mechanism' }],
      counterevidence: { disposition: 'searched_none_found', searchedScope: 'fixture substrate', claimKeys: [] },
    } }],
  };
  assert.equal((await transaction(c => loadSubstrateSeed(c, JSON.stringify(seed)))).status, 'loaded');
  const bridgeId = (await pool.query<{ id: string }>(
    'SELECT b.id FROM bridge b JOIN concept f ON f.id = b.from_concept_id WHERE f.code = $1 AND b.status = \'admitted\'', [codes.gravity])).rows[0]!.id;
  return { tag, codes, scrolls, bridgeId, material: name => `https://science.nasa.gov/fixture/${tag}/${name}/` };
}

/** A hand-written page of fixture material, long enough to write a Scroll from. `sentinel` is a
 * sentence no written Scroll quotes, so a test can prove the material never reaches a reader. */
export function materialPage(topic: string, sentinel: string): string {
  return `<!doctype html><html><head><title>What makes the ${topic}</title></head><body><nav>Menu Search</nav><main><h1>${topic}</h1><p>
Fixture material about ${topic}, written by hand for tests and never fetched from anywhere real.
The Moon pulls on the whole Earth, but it pulls hardest on the side of the planet that faces it.
Water on that side is drawn into a bulge, and a second bulge forms on the far side, where the pull is weakest.
As Earth turns, a coast passes through both bulges, so many shores see two high tides and two low tides every day. ${sentinel}
</p></main><footer>Footer</footer></body></html>`;
}

/** A mocked network that serves only the given pages. */
export function fixtureNetwork(pages: Record<string, string>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requested.push(String(input));
    const body = pages[String(input)];
    if (body === undefined) throw new TypeError('fixture network: nothing there');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

/** Two days of reading, compressed: the reader keeps a Tides Scroll, the day moves back, and they keep
 * the other two (from a second source family). Tides is anchored, a planet forms, and every Scroll
 * in its subtree has been shown. */
export async function readTidesInFull(app: ReturnType<typeof buildApp>, headers: Record<string, string>, universeId: string, f: InventoryFixture): Promise<void> {
  await readScroll(app, headers, f.scrolls.tides[0], true);
  await pool.query("UPDATE ledger SET created_at = created_at - interval '1 day' WHERE universe_id=$1", [universeId]);
  await readScroll(app, headers, f.scrolls.tides[1], true);
  await readScroll(app, headers, f.scrolls.tides[2], true);
}
