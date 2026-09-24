/**
 * #133 — offline comparison of `composer-signals-v2` and `composer-semantic-v3` (ADR-0032 §3,
 * "usefulness is evaluated separately from correctness"). Run against a disposable, migrated and
 * seeded database, through the real API with each policy configured:
 *
 *   ./scripts/test.sh scripts/composer-compare.ts
 *
 * Scripted readers walk the real editorial library for the same number of deliberate steps,
 * sending what they opened this session and picking the first served encounter they have not opened (as both clients do),
 * exposing it, and keeping it only when it matches their fixed interest. The report measures
 * behaviour — grounding in the reader's own acts, staying with an interest, reaching the rest of the
 * library, exploration and repetition — never usefulness, which needs a person (owner review).
 *
 * #167 (ADR-0043): the library also holds gated test Reels, one over every other Scroll, each
 * carrying its Scroll's concepts. Golden readers (the two interest readers, and a Reel-heavy reader
 * who reads in Reel mode three steps of four) and adversarial readers (the watcher, a reader who
 * only skips through Scrolls and Reels, a reader with one narrow interest, and a cold start) walk it.
 * Reel measures: how many Reels were reached, "echoes" (a Reel served right after its own Scroll,
 * or the reverse) and slates that offer a Reel beside its own Scroll.
 * No provider call. Writes artifacts/composer-compare/report.{json,md}.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';
import { mintGatedTestReel } from './fixtures/gated-reel.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Composer comparison requires a disposable knowscroll_test_* database');

const STEPS = 20;
// v3 breaks score ties with a hash salted by the universe id, so one walk per reader can mislead:
// each reader walks REPEATS times with fresh universes and the table reports mean (min–max).
const REPEATS = 3;
const token = randomBytes(32).toString('hex');
const apps = { 'composer-signals-v2': buildApp(token, { composerPolicy: 'composer-signals-v2' }), 'composer-semantic-v3': buildApp(token) } as const;
after(async () => { for (const app of Object.values(apps)) await app.close(); await pool.end(); });

type Kinds = 'Scroll' | 'Reel' | 'Scroll,Reel';
type Persona = { name: string; set: 'golden' | 'adversarial'; interest: string; keeps: (primary: string | null) => boolean; kinds: (step: number) => Kinds };
const sky = (p: string | null) => p !== null && (p.startsWith('astro') || p.startsWith('physics'));
const PERSONAS: Persona[] = [
  { name: 'sky reader', set: 'golden', interest: 'astro.* or physics.*', keeps: sky, kinds: () => 'Scroll' },
  { name: 'living-systems reader', set: 'golden', interest: 'bio.* or earth.climate.*', keeps: p => p !== null && (p.startsWith('bio') || p.startsWith('earth.climate')), kinds: () => 'Scroll' },
  { name: 'Reel-heavy sky reader', set: 'golden', interest: 'astro.* or physics.*; Reel mode three steps of four', keeps: sky, kinds: step => (step % 4 === 0 ? 'Scroll' : 'Reel') },
  { name: 'watcher', set: 'adversarial', interest: 'none (never keeps)', keeps: () => false, kinds: () => 'Scroll' },
  { name: 'skipper', set: 'adversarial', interest: 'none (never keeps); Scrolls and Reels', keeps: () => false, kinds: () => 'Scroll,Reel' },
  { name: 'narrow reader', set: 'adversarial', interest: 'earth.tides only; Scrolls and Reels', keeps: p => p === 'earth.tides', kinds: () => 'Scroll,Reel' },
];

type Step = {
  step: number; assetId: string; kind: string; title: string; primary: string | null; domain: string | null; family: string | null;
  reason: string; grounded: boolean; kept: boolean; material: string; slateSharesMaterial: boolean;
};
type Library = { annotated: Map<string, { primary: string | null; domain: string | null }>; material: Map<string, string> };

async function describeLibrary(): Promise<Library> {
  const rows = (await pool.query<{ asset_id: string; code: string }>(
    `SELECT ac.asset_id, c.code FROM asset_concept ac JOIN concept c ON c.id=ac.concept_id WHERE ac.role='primary'`)).rows;
  // What a Reel restates: the one library Scroll its brief was authored over (ADR-0023).
  const reels = (await pool.query<{ id: string; source_asset_id: string }>(
    `SELECT a.id, b.source_asset_id FROM asset a JOIN generated_reel g ON g.id=a.generated_reel_id JOIN generation_brief b ON b.id=g.brief_id WHERE a.kind='Reel'`)).rows;
  return {
    annotated: new Map(rows.map(r => [r.asset_id, { primary: r.code, domain: r.code.split('.')[0]! }])),
    material: new Map(reels.map(r => [r.id, r.source_asset_id])),
  };
}

/** One gated test Reel over every other editorial Scroll (scripts/fixtures/gated-reel.ts). */
async function mintReels(): Promise<number> {
  const scrolls = (await pool.query<{ id: string; title: string }>(`SELECT id, title FROM asset WHERE kind='Scroll' ORDER BY editorial_order`)).rows;
  const over = scrolls.filter((_, i) => i % 2 === 0);
  for (const [i, s] of over.entries()) await mintGatedTestReel(pool, s.id, { tag: `compare-${i + 1}`, title: `${s.title} (Reel)`, summary: `A test Reel over “${s.title}”.` });
  return over.length;
}

type Feed = { decisionId: string; items: { assetId: string; kind: string; title: string; reason: string }[] };

async function walk(policy: keyof typeof apps, persona: Persona, library: Library): Promise<{ steps: Step[]; exhaustedAt: number | null }> {
  const app = apps[policy];
  const identity = await provisionIdentity();
  const headers = { authorization: `Bearer ${identity.token}` };
  const visited = new Set<string>();
  const steps: Step[] = [];
  const materialOf = (id: string) => library.material.get(id) ?? id;
  const compose = async (kinds: Kinds) => {
    // As the clients do (#133): the trip tells the feed what it already opened.
    const exclude = [...visited].slice(-256).join(',');
    const feed = await app.inject({ url: `/v1/feed?kinds=${kinds}${exclude ? `&exclude=${exclude}` : ''}`, headers });
    assert.equal(feed.statusCode, 200, feed.body);
    const body = feed.json() as Feed;
    return { body, item: body.items.find(i => !visited.has(i.assetId)) };
  };
  for (let step = 1; step <= STEPS; step += 1) {
    const kinds = persona.kinds(step);
    let { body, item } = await compose(kinds);
    // A reader whose Reel mode has nothing new left switches to Scrolls, as a person would.
    if (!item && kinds === 'Reel') ({ body, item } = await compose('Scroll'));
    if (!item) return { steps, exhaustedAt: step };
    visited.add(item.assetId);
    const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers, payload: { decisionId: body.decisionId, assetId: item.assetId, clientExposureId: randomUUID() } });
    assert.equal(exposure.statusCode, 201, exposure.body);
    const meta = library.annotated.get(item.assetId) ?? { primary: null, domain: null };
    const kept = persona.keeps(meta.primary);
    if (kept) {
      const keep = await app.inject({ method: 'POST', url: '/v1/interactions', headers,
        payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId: item.assetId, kind: 'keep' } });
      assert.equal(keep.statusCode, 202, keep.body);
    }
    const candidate = (await pool.query<{ family: string; evidence: { kind: string }[] }>(
      'SELECT family, evidence FROM decision_candidate WHERE decision_id=$1 AND asset_id=$2 AND rank IS NOT NULL', [body.decisionId, item.assetId])).rows[0];
    const materials = body.items.map(i => materialOf(i.assetId));
    steps.push({ step, assetId: item.assetId, kind: item.kind, title: item.title, primary: meta.primary, domain: meta.domain, family: candidate?.family ?? null,
      reason: item.reason, grounded: candidate?.evidence.some(e => e.kind === 'mark') ?? false, kept,
      material: materialOf(item.assetId), slateSharesMaterial: new Set(materials).size < materials.length });
  }
  return { steps, exhaustedAt: null };
}

function measure(persona: Persona, run: { steps: Step[]; exhaustedAt: number | null }, interestAvailable: number) {
  const s = run.steps;
  const firstKeep = s.findIndex(x => x.kept);
  const afterKeep = firstKeep < 0 ? [] : s.slice(firstKeep + 1);
  const share = (xs: Step[], f: (x: Step) => boolean) => xs.length === 0 ? null : Math.round((xs.filter(f).length / xs.length) * 100) / 100;
  const echoes = s.slice(1).filter((x, i) => x.material === s[i]!.material);
  return {
    served: s.length,
    exhaustedAtStep: run.exhaustedAt,
    distinctDomains: new Set(s.map(x => x.domain ?? 'unmapped')).size,
    keeps: s.filter(x => x.kept).length,
    // Reaching the reader's interest sooner is better; "on-interest after the first keep" alone
    // penalises the policy that found it first, so both are reported.
    keepsInFirst10: s.slice(0, 10).filter(x => x.kept).length,
    stepAllInterestKept: interestAvailable > 0 && s.filter(x => x.kept).length === interestAvailable ? s.length - [...s].reverse().findIndex(x => x.kept) : null,
    onInterestAfterFirstKeep: persona.interest.startsWith('none') ? null : share(afterKeep, x => persona.keeps(x.primary)),
    groundedInOwnActs: share(s, x => x.grounded),
    adjacentSameIdea: s.slice(1).filter((x, i) => x.primary !== null && x.primary === s[i]!.primary).length,
    unmappedServed: s.filter(x => x.primary === null).length,
    reelsServed: s.filter(x => x.kind === 'Reel').length,
    // The same material twice in a row: a Reel right after its own Scroll, or the reverse.
    echoes: echoes.length,
    slatesSharingMaterial: s.filter(x => x.slateSharesMaterial).length,
    families: s.reduce<Record<string, number>>((acc, x) => { const k = x.family ?? 'n/a'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
  };
}

/** Cold start: the first slate a new reader is offered, Scrolls and Reels together. */
async function coldStart(policy: keyof typeof apps, library: Library) {
  const identity = await provisionIdentity();
  const feed = await apps[policy].inject({ url: '/v1/feed?kinds=Scroll,Reel', headers: { authorization: `Bearer ${identity.token}` } });
  assert.equal(feed.statusCode, 200, feed.body);
  const items = (feed.json() as Feed).items;
  const materials = items.map(i => library.material.get(i.assetId) ?? i.assetId);
  return {
    slate: items.length,
    domains: new Set(items.map(i => library.annotated.get(i.assetId)?.domain ?? 'unmapped')).size,
    reels: items.filter(i => i.kind === 'Reel').length,
    sharesMaterial: new Set(materials).size < materials.length,
  };
}

test('compare composer-signals-v2 and composer-semantic-v3 on the real editorial library, with Reels', async () => {
  const reels = await mintReels();
  const library = await describeLibrary();
  const scrolls = Number((await pool.query("SELECT count(*) FROM asset WHERE kind='Scroll'")).rows[0].count);
  type Measured = ReturnType<typeof measure> & { sequence: string[] };
  const results: Record<string, Record<string, Measured[]>> = {};
  for (const persona of PERSONAS) {
    results[persona.name] = {};
    const kinds = new Set(Array.from({ length: STEPS }, (_, i) => persona.kinds(i + 1)).flatMap(k => k.split(',')));
    const interestAvailable = [...library.annotated].filter(([id, a]) => persona.keeps(a.primary) && kinds.has(library.material.has(id) ? 'Reel' : 'Scroll')).length;
    for (const policy of Object.keys(apps) as (keyof typeof apps)[]) {
      results[persona.name]![policy] = [];
      for (let r = 0; r < REPEATS; r += 1) {
        const run = await walk(policy, persona, library);
        results[persona.name]![policy]!.push({ ...measure(persona, run, interestAvailable),
          sequence: run.steps.map(x => `${x.kept ? '★ ' : ''}${x.kind === 'Reel' ? '▶ ' : ''}${x.title} [${x.primary ?? 'unmapped'}${x.family ? ` · ${x.family}` : ''}]`) });
      }
    }
  }
  const cold: Record<string, Awaited<ReturnType<typeof coldStart>>[]> = {};
  for (const policy of Object.keys(apps) as (keyof typeof apps)[]) {
    cold[policy] = [];
    for (let r = 0; r < REPEATS; r += 1) cold[policy]!.push(await coldStart(policy, library));
  }
  const stat = <T>(runs: T[], f: (m: T) => number | null) => {
    const xs = runs.map(f).filter((x): x is number => x !== null);
    if (xs.length === 0) return '—';
    const mean = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return lo === hi ? `${mean}${xs.length < runs.length ? ` (${xs.length}/${runs.length} runs)` : ''}` : `${mean} (${lo}–${hi})${xs.length < runs.length ? ` in ${xs.length}/${runs.length}` : ''}`;
  };
  const report = { at: new Date().toISOString(), steps: STEPS, repeats: REPEATS, library: { scrolls, reels }, providerCalls: 0,
    personas: PERSONAS.map(p => ({ name: p.name, set: p.set, interest: p.interest })), results, coldStart: cold };
  const rows = PERSONAS.flatMap(persona => Object.entries(results[persona.name]!).map(([policy, runs]) =>
    `| ${persona.set} | ${persona.name} | ${policy} | ${stat(runs, m => m.keeps)} | ${stat(runs, m => m.keepsInFirst10)} | ${stat(runs, m => m.stepAllInterestKept)} | ${stat(runs, m => m.groundedInOwnActs)} | ${stat(runs, m => m.distinctDomains)} | ${stat(runs, m => m.adjacentSameIdea)} | ${stat(runs, m => m.reelsServed)} | ${stat(runs, m => m.echoes)} | ${stat(runs, m => m.slatesSharingMaterial)} | ${stat(runs, m => m.exhaustedAtStep)} |`));
  const coldRows = Object.entries(cold).map(([policy, runs]) =>
    `| ${policy} | ${stat(runs, m => m.slate)} | ${stat(runs, m => m.domains)} | ${stat(runs, m => m.reels)} | ${runs.filter(m => m.sharesMaterial).length}/${runs.length} |`);
  const md = [`# Composer comparison (${report.at})`, '', `Library: ${scrolls} Scrolls and ${reels} test Reels (one over every other Scroll); ${STEPS} deliberate steps per reader, ${REPEATS} walks each; no provider call.`, '',
    '| Set | Reader | Policy | Keeps in 20 | Keeps in first 10 | All interest kept by step | Grounded in own acts | Domains touched | Adjacent same idea | Reels served | Echoes | Slates pairing a Reel with its Scroll | Exhausted at step |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...rows, '',
    '## Cold start (first slate, Scrolls and Reels)', '', '| Policy | Slate size | Domains in slate | Reels in slate | Slates pairing a Reel with its Scroll |', '|---|---|---|---|---|', ...coldRows, '',
    ...PERSONAS.flatMap(persona => Object.entries(results[persona.name]!).flatMap(([policy, runs]) => [`## ${persona.name} — ${policy} (first run)`, '', ...runs[0]!.sequence.map((x, i) => `${i + 1}. ${x}`), ''])),
  ].join('\n');
  mkdirSync('artifacts/composer-compare', { recursive: true });
  writeFileSync('artifacts/composer-compare/report.json', JSON.stringify(report, null, 2) + '\n');
  writeFileSync('artifacts/composer-compare/report.md', md + '\n');
  console.log(md.split('\n').slice(0, 25).join('\n'));
});
