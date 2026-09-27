/**
 * #131 — a unique, self-contained editorial substrate for SQL/HTTP tests. Knowledge rows are
 * global and immutable, so every call mints its own codes/keys (`t<tag>…`) and its own Scroll
 * assets, and never collides with another test file or the real editorial seed.
 *
 * Shape: gravity explains tides (justified, directional); stellar balance is like homeostasis
 * through a shared equilibrium mechanism (justified analogy); "the elliptical orbit explains the
 * seasons" (tempting, contradicted by the substrate). Three sources, so a correction to one can be
 * shown to revoke exactly the bridges whose evidence depended on it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SubstrateSeed } from '../../packages/contracts/src/semantic.ts';

export type SemanticFixture = {
  tag: string;
  seed: SubstrateSeed;
  raw: string;
  assets: { gravity: string; tides: string; star: string; body: string; seasons: string; unannotated: string };
  codes: Record<'root' | 'gravity' | 'tides' | 'orbit' | 'ellipse' | 'seasons' | 'tilt' | 'star' | 'balance' | 'body' | 'homeostasis' | 'equilibrium', string>;
  sources: { physics: string; stars: string; biology: string };
};

const hash = () => randomBytes(32).toString('hex');

async function insertScroll(client: pg.Pool | pg.PoolClient, title: string, sourceTitle: string, sourceUrl: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
     VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',(SELECT COALESCE(MAX(editorial_order),0)+1 FROM asset))`,
    [id, title, `Summary of ${title}`, `Body of ${title}.`, sourceTitle, sourceUrl],
  );
  return id;
}

/** `personal` names bridge proposals (by suffix, e.g. 'balance_homeostasis') to hold out of the
 * shared seed so a test can admit them in one universe's own scope. */
export async function makeSemanticFixture(client: pg.Pool | pg.PoolClient, options: { personal?: string[] } = {}): Promise<SemanticFixture & { personal: Record<string, SubstrateSeed['bridgeProposals'][number]['payload']> }> {
  const built = await buildFixture(client);
  const personal: Record<string, SubstrateSeed['bridgeProposals'][number]['payload']> = {};
  for (const suffix of options.personal ?? []) {
    const held = built.seed.bridgeProposals.find(p => p.key === `brg.${built.tag}.${suffix}`);
    if (!held) throw new Error(`unknown fixture proposal ${suffix}`);
    personal[suffix] = held.payload;
  }
  const seed = { ...built.seed, bridgeProposals: built.seed.bridgeProposals.filter(p => !Object.keys(personal).some(s => p.key === `brg.${built.tag}.${s}`)) };
  return { ...built, seed, raw: JSON.stringify(seed), personal };
}

async function buildFixture(client: pg.Pool | pg.PoolClient): Promise<SemanticFixture> {
  const tag = `t${randomBytes(5).toString('hex')}`;
  const c = (s: string) => `${tag}.${s}`;
  const codes = {
    root: tag, gravity: c('gravity'), tides: c('tides'), orbit: c('orbit'), ellipse: c('orbit.ellipse'),
    seasons: c('seasons'), tilt: c('seasons.tilt'), star: c('star'), balance: c('star.balance'),
    body: c('body'), homeostasis: c('body.homeostasis'), equilibrium: c('equilibrium'),
  } as const;
  const k = (s: string) => `clm.${tag}.${s}`;
  const sources = { physics: `src.${tag}.physics`, stars: `src.${tag}.stars`, biology: `src.${tag}.biology` };
  const url = (s: string) => `https://example.test/${tag}/${s}`;

  const assets = {
    gravity: await insertScroll(client, `${tag} Gravity pulls`, 'Physics fixture', url('physics')),
    tides: await insertScroll(client, `${tag} Why the sea rises`, 'Physics fixture', url('physics')),
    star: await insertScroll(client, `${tag} A star balances`, 'Stars fixture', url('stars')),
    body: await insertScroll(client, `${tag} A body stays steady`, 'Biology fixture', url('biology')),
    seasons: await insertScroll(client, `${tag} Why seasons change`, 'Physics fixture', url('physics')),
    unannotated: await insertScroll(client, `${tag} Not annotated`, 'Physics fixture', url('physics')),
  };

  const quote = 'A verbatim passage long enough to be a quote.';
  const seed: SubstrateSeed = {
    version: `editorial-substrate-2026-09-24.${parseInt(randomBytes(3).toString('hex'), 16)}`,
    families: [{ key: `fam.${tag}`, kind: 'publisher', description: 'Synthetic test publisher family' }],
    sources: [
      { key: sources.physics, url: url('physics'), title: 'Physics fixture', publisher: 'Fixture', familyKey: `fam.${tag}`, retrievedAt: '2026-09-24', contentSha256: hash() },
      { key: sources.stars, url: url('stars'), title: 'Stars fixture', publisher: 'Fixture', familyKey: `fam.${tag}`, retrievedAt: '2026-09-24', contentSha256: hash() },
      { key: sources.biology, url: url('biology'), title: 'Biology fixture', publisher: 'Fixture', familyKey: `fam.${tag}`, retrievedAt: '2026-09-24', contentSha256: hash() },
    ],
    concepts: [
      { code: codes.root, name: 'Fixture root', description: 'Root of a synthetic test substrate', kind: 'idea', parentCode: null },
      { code: codes.gravity, name: 'Gravity', description: 'The attraction between masses', kind: 'phenomenon', parentCode: codes.root },
      { code: codes.tides, name: 'Tides', description: 'The regular rise and fall of the sea', kind: 'phenomenon', parentCode: codes.root },
      { code: codes.orbit, name: 'Orbit', description: 'The curved path of one body around another', kind: 'process', parentCode: codes.root },
      { code: codes.ellipse, name: 'Elliptical orbit', description: 'An orbit whose distance from the Sun changes', kind: 'object', parentCode: codes.orbit },
      { code: codes.seasons, name: 'Seasons', description: 'Yearly changes in temperature and daylight', kind: 'phenomenon', parentCode: codes.root },
      { code: codes.tilt, name: 'Axial tilt', description: 'Earth leans on its axis of rotation', kind: 'quantity', parentCode: codes.seasons },
      { code: codes.star, name: 'Star', description: 'A ball of hot gas held together by gravity', kind: 'object', parentCode: codes.root },
      { code: codes.balance, name: 'Stellar balance', description: 'Gravity pulls in while pressure pushes out', kind: 'mechanism', parentCode: codes.star },
      { code: codes.body, name: 'Body', description: 'A living organism', kind: 'object', parentCode: codes.root },
      { code: codes.homeostasis, name: 'Homeostasis', description: 'Keeping internal conditions within a stable range', kind: 'process', parentCode: codes.body },
      { code: codes.equilibrium, name: 'Equilibrium', description: 'A steady state kept by opposing effects', kind: 'idea', parentCode: codes.root },
    ],
    claims: [
      { key: k('gravity_attraction'), statement: 'Every mass attracts every other mass through gravity.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'subject' }], support: [{ sourceKey: sources.physics, quote, supportKind: 'supports' }] },
      { key: k('gravity_tides'), statement: 'The Moon\'s and Sun\'s gravity pull on the oceans and cause the tides.', truthState: 'documented',
        concepts: [{ code: codes.gravity, role: 'mechanism' }, { code: codes.tides, role: 'subject' }], support: [{ sourceKey: sources.physics, quote, supportKind: 'supports' }] },
      { key: k('tides_cycle'), statement: 'Most coasts see two high and two low tides each day.', truthState: 'documented',
        concepts: [{ code: codes.tides, role: 'subject' }], support: [{ sourceKey: sources.physics, quote, supportKind: 'supports' }] },
      { key: k('orbit_ellipse'), statement: 'Earth\'s orbit is an ellipse, so its distance from the Sun varies.', truthState: 'documented',
        concepts: [{ code: codes.ellipse, role: 'subject' }], support: [{ sourceKey: sources.physics, quote, supportKind: 'supports' }] },
      { key: k('seasons_tilt'), statement: 'Seasons come from the tilt of Earth\'s axis, not from its changing distance to the Sun.', truthState: 'documented',
        concepts: [{ code: codes.seasons, role: 'subject' }, { code: codes.tilt, role: 'mechanism' }, { code: codes.ellipse, role: 'context' }], support: [{ sourceKey: sources.physics, quote, supportKind: 'supports' }] },
      { key: k('star_balance'), statement: 'A star holds its size while gravity and outward pressure balance.', truthState: 'documented',
        concepts: [{ code: codes.balance, role: 'subject' }, { code: codes.equilibrium, role: 'mechanism' }], support: [{ sourceKey: sources.stars, quote, supportKind: 'supports' }] },
      { key: k('body_stable'), statement: 'A body keeps its internal conditions within a stable range despite change.', truthState: 'documented',
        concepts: [{ code: codes.homeostasis, role: 'subject' }, { code: codes.equilibrium, role: 'mechanism' }], support: [{ sourceKey: sources.biology, quote, supportKind: 'supports' }] },
      { key: k('star_hot_gas'), statement: 'A star is a large ball of hot gas held together by its own gravity.', truthState: 'documented',
        concepts: [{ code: codes.star, role: 'subject' }], support: [{ sourceKey: sources.stars, quote, supportKind: 'supports' }] },
      { key: k('body_definition'), statement: 'Homeostasis is how a body keeps its internal conditions steady.', truthState: 'documented',
        concepts: [{ code: codes.homeostasis, role: 'subject' }], support: [{ sourceKey: sources.biology, quote, supportKind: 'supports' }] },
    ],
    relations: [
      { from: codes.ellipse, to: codes.seasons, kind: 'contradicts', claimKey: k('seasons_tilt') },
      { from: codes.gravity, to: codes.tides, kind: 'explains', claimKey: k('gravity_tides') },
    ],
    assets: [
      { assetId: assets.gravity, concepts: [{ code: codes.gravity, role: 'primary' }], claims: [k('gravity_attraction')] },
      { assetId: assets.tides, concepts: [{ code: codes.tides, role: 'primary' }, { code: codes.gravity, role: 'mentioned' }], claims: [k('tides_cycle'), k('gravity_tides')] },
      { assetId: assets.star, concepts: [{ code: codes.balance, role: 'primary' }], claims: [k('star_balance')] },
      { assetId: assets.body, concepts: [{ code: codes.homeostasis, role: 'primary' }], claims: [k('body_stable')] },
      { assetId: assets.seasons, concepts: [{ code: codes.seasons, role: 'primary' }], claims: [k('seasons_tilt')] },
    ],
    bridgeProposals: [
      { key: `brg.${tag}.gravity_tides`, payload: {
        fromConcept: codes.gravity, toConcept: codes.tides, relationType: 'explains',
        mechanism: 'The Moon and Sun pull on Earth\'s oceans with gravity; water nearest the Moon is pulled more strongly, so it bulges, and each coast passes through the bulges as Earth turns.',
        prerequisites: [{ statement: 'Masses attract one another through gravity' }],
        limitations: [{ kind: 'scope_limit', statement: 'Coastline shape changes the timing and height of local tides' }],
        evidence: [{ claimKey: k('gravity_attraction'), supports: 'from' }, { claimKey: k('tides_cycle'), supports: 'to' }, { claimKey: k('gravity_tides'), supports: 'mechanism' }],
        counterevidence: { disposition: 'searched_none_found', searchedScope: 'fixture substrate', claimKeys: [] },
      } },
      { key: `brg.${tag}.balance_homeostasis`, payload: {
        fromConcept: codes.balance, toConcept: codes.homeostasis, relationType: 'analogous_in',
        mechanism: 'Both are steady states held by opposing effects: inward gravity against outward pressure in a star, and changes pushed back toward a stable range in a body.',
        prerequisites: [{ statement: 'A steady state can come from two effects that cancel' }],
        limitations: [{ kind: 'analogy_limit', statement: 'A star has no sensor, set point or control centre; its balance is passive' }],
        evidence: [{ claimKey: k('star_hot_gas'), supports: 'from' }, { claimKey: k('body_definition'), supports: 'to' },
          { claimKey: k('star_balance'), supports: 'mechanism' }, { claimKey: k('body_stable'), supports: 'mechanism' }],
        counterevidence: { disposition: 'searched_none_found', searchedScope: 'fixture substrate', claimKeys: [] },
      } },
      { key: `brg.${tag}.ellipse_seasons`, payload: {
        fromConcept: codes.ellipse, toConcept: codes.seasons, relationType: 'explains',
        mechanism: 'Earth is closer to the Sun at some points of its elliptical orbit and farther at others, so the changing distance would make some months warmer than others.',
        prerequisites: [{ statement: 'Earth\'s distance from the Sun changes over a year' }],
        limitations: [{ kind: 'scope_limit', statement: 'Both hemispheres would share one season' }],
        evidence: [{ claimKey: k('orbit_ellipse'), supports: 'from' }, { claimKey: k('seasons_tilt'), supports: 'to' }, { claimKey: k('orbit_ellipse'), supports: 'mechanism' }],
        counterevidence: { disposition: 'searched_none_found', searchedScope: 'fixture substrate', claimKeys: [] },
      } },
    ],
  };
  return { tag, seed, raw: JSON.stringify(seed), assets, codes, sources };
}
