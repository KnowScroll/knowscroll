/**
 * #133 — offline comparison of `composer-signals-v2` and `composer-semantic-v3` (ADR-0032 §3,
 * "usefulness is evaluated separately from correctness"). Run against a disposable, migrated and
 * seeded database, through the real API with each policy configured:
 *
 *   ./scripts/test.sh scripts/composer-compare.ts
 *
 * Three scripted readers walk the real editorial library for the same number of deliberate steps,
 * sending what they opened this session and picking the first served Scroll they have not opened (as both clients do),
 * exposing it, and keeping it only when it matches their fixed interest. The report measures
 * behaviour — grounding in the reader's own acts, staying with an interest, reaching the rest of the
 * library, exploration and repetition — never usefulness, which needs a person (owner review).
 * No provider call. Writes artifacts/composer-compare/report.{json,md}.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';

if (!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Composer comparison requires a disposable knowscroll_test_* database');

const STEPS = 20;
// v3 breaks score ties with a hash salted by the universe id, so one walk per reader can mislead:
// each reader walks REPEATS times with fresh universes and the table reports mean (min–max).
const REPEATS = 3;
const token = randomBytes(32).toString('hex');
const apps = { 'composer-signals-v2': buildApp(token, { composerPolicy: 'composer-signals-v2' }), 'composer-semantic-v3': buildApp(token) } as const;
after(async () => { for (const app of Object.values(apps)) await app.close(); await pool.end(); });

type Persona = { name: string; keeps: (primary: string | null) => boolean; interest: string };
const PERSONAS: Persona[] = [
  { name: 'sky reader', interest: 'astro.* or physics.*', keeps: p => p !== null && (p.startsWith('astro') || p.startsWith('physics')) },
  { name: 'living-systems reader', interest: 'bio.* or earth.climate.*', keeps: p => p !== null && (p.startsWith('bio') || p.startsWith('earth.climate')) },
  { name: 'watcher', interest: 'none (never keeps)', keeps: () => false },
];

type Step = { step: number; assetId: string; title: string; primary: string | null; domain: string | null; family: string | null; reason: string; grounded: boolean; kept: boolean };

async function primaries(): Promise<Map<string, { primary: string | null; domain: string | null }>> {
  const rows = (await pool.query<{ asset_id: string; code: string }>(
    `SELECT ac.asset_id, c.code FROM asset_concept ac JOIN concept c ON c.id=ac.concept_id WHERE ac.role='primary'`)).rows;
  return new Map(rows.map(r => [r.asset_id, { primary: r.code, domain: r.code.split('.')[0]! }]));
}

async function walk(policy: keyof typeof apps, persona: Persona, annotated: Awaited<ReturnType<typeof primaries>>): Promise<{ steps: Step[]; exhaustedAt: number | null }> {
  const app = apps[policy];
  const identity = await provisionIdentity();
  const headers = { authorization: `Bearer ${identity.token}` };
  const visited = new Set<string>();
  const steps: Step[] = [];
  for (let step = 1; step <= STEPS; step += 1) {
    // As the clients do (#133): the trip tells the feed what it already opened.
    const exclude = [...visited].slice(-256).join(',');
    const feed = await app.inject({ url: `/v1/feed?kinds=Scroll${exclude ? `&exclude=${exclude}` : ''}`, headers });
    assert.equal(feed.statusCode, 200, feed.body);
    const body = feed.json() as { decisionId: string; items: { assetId: string; title: string; reason: string }[] };
    const item = body.items.find(i => !visited.has(i.assetId));
    if (!item) return { steps, exhaustedAt: step };
    visited.add(item.assetId);
    const exposure = await app.inject({ method: 'POST', url: '/v1/exposures', headers, payload: { decisionId: body.decisionId, assetId: item.assetId, clientExposureId: randomUUID() } });
    assert.equal(exposure.statusCode, 201, exposure.body);
    const meta = annotated.get(item.assetId) ?? { primary: null, domain: null };
    const kept = persona.keeps(meta.primary);
    if (kept) {
      const keep = await app.inject({ method: 'POST', url: '/v1/interactions', headers,
        payload: { clientEventId: randomUUID(), exposureId: exposure.json().exposureId, assetId: item.assetId, kind: 'keep' } });
      assert.equal(keep.statusCode, 202, keep.body);
    }
    const candidate = (await pool.query<{ family: string; evidence: { kind: string }[] }>(
      'SELECT family, evidence FROM decision_candidate WHERE decision_id=$1 AND asset_id=$2 AND rank IS NOT NULL', [body.decisionId, item.assetId])).rows[0];
    steps.push({ step, assetId: item.assetId, title: item.title, primary: meta.primary, domain: meta.domain, family: candidate?.family ?? null,
      reason: item.reason, grounded: candidate?.evidence.some(e => e.kind === 'mark') ?? false, kept });
  }
  return { steps, exhaustedAt: null };
}

function measure(persona: Persona, run: { steps: Step[]; exhaustedAt: number | null }, interestAvailable: number) {
  const s = run.steps;
  const firstKeep = s.findIndex(x => x.kept);
  const afterKeep = firstKeep < 0 ? [] : s.slice(firstKeep + 1);
  const share = (xs: Step[], f: (x: Step) => boolean) => xs.length === 0 ? null : Math.round((xs.filter(f).length / xs.length) * 100) / 100;
  return {
    served: s.length,
    exhaustedAtStep: run.exhaustedAt,
    distinctDomains: new Set(s.map(x => x.domain ?? 'unmapped')).size,
    keeps: s.filter(x => x.kept).length,
    // Reaching the reader's interest sooner is better; "on-interest after the first keep" alone
    // penalises the policy that found it first, so both are reported.
    keepsInFirst10: s.slice(0, 10).filter(x => x.kept).length,
    stepAllInterestKept: interestAvailable > 0 && s.filter(x => x.kept).length === interestAvailable ? s.length - [...s].reverse().findIndex(x => x.kept) : null,
    onInterestAfterFirstKeep: persona.name === 'watcher' ? null : share(afterKeep, x => persona.keeps(x.primary)),
    groundedInOwnActs: share(s, x => x.grounded),
    adjacentSameIdea: s.slice(1).filter((x, i) => x.primary !== null && x.primary === s[i]!.primary).length,
    unmappedServed: s.filter(x => x.primary === null).length,
    families: s.reduce<Record<string, number>>((acc, x) => { const k = x.family ?? 'n/a'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
  };
}

test('compare composer-signals-v2 and composer-semantic-v3 on the real editorial library', async () => {
  const annotated = await primaries();
  const library = Number((await pool.query("SELECT count(*) FROM asset WHERE kind='Scroll'")).rows[0].count);
  type Measured = ReturnType<typeof measure> & { sequence: string[] };
  const results: Record<string, Record<string, Measured[]>> = {};
  for (const persona of PERSONAS) {
    results[persona.name] = {};
    const interestAvailable = [...annotated.values()].filter(a => persona.keeps(a.primary)).length;
    for (const policy of Object.keys(apps) as (keyof typeof apps)[]) {
      results[persona.name]![policy] = [];
      for (let r = 0; r < REPEATS; r += 1) {
        const run = await walk(policy, persona, annotated);
        results[persona.name]![policy]!.push({ ...measure(persona, run, interestAvailable),
          sequence: run.steps.map(x => `${x.kept ? '★ ' : ''}${x.title} [${x.primary ?? 'unmapped'}${x.family ? ` · ${x.family}` : ''}]`) });
      }
    }
  }
  const stat = (runs: Measured[], f: (m: Measured) => number | null) => {
    const xs = runs.map(f).filter((x): x is number => x !== null);
    if (xs.length === 0) return '—';
    const mean = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return lo === hi ? `${mean}${xs.length < runs.length ? ` (${xs.length}/${runs.length} runs)` : ''}` : `${mean} (${lo}–${hi})${xs.length < runs.length ? ` in ${xs.length}/${runs.length}` : ''}`;
  };
  const report = { at: new Date().toISOString(), steps: STEPS, repeats: REPEATS, library, providerCalls: 0, personas: PERSONAS.map(p => ({ name: p.name, interest: p.interest })), results };
  const rows = Object.entries(results).flatMap(([persona, byPolicy]) => Object.entries(byPolicy).map(([policy, runs]) =>
    `| ${persona} | ${policy} | ${stat(runs, m => m.keeps)} | ${stat(runs, m => m.keepsInFirst10)} | ${stat(runs, m => m.stepAllInterestKept)} | ${stat(runs, m => m.groundedInOwnActs)} | ${stat(runs, m => m.distinctDomains)} | ${stat(runs, m => m.adjacentSameIdea)} | ${stat(runs, m => m.exhaustedAtStep)} |`));
  const md = [`# Composer comparison (${report.at})`, '', `Library: ${library} Scrolls; ${STEPS} deliberate steps per reader; no provider call.`, '',
    '| Reader | Policy | Keeps in 20 | Keeps in first 10 | All interest kept by step | Grounded in own acts | Domains touched | Adjacent same idea | Exhausted at step |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, '',
    ...Object.entries(results).flatMap(([persona, byPolicy]) => Object.entries(byPolicy).flatMap(([policy, runs]) => [`## ${persona} — ${policy} (first run)`, '', ...runs[0]!.sequence.map((x, i) => `${i + 1}. ${x}`), ''])),
  ].join('\n');
  mkdirSync('artifacts/composer-compare', { recursive: true });
  writeFileSync('artifacts/composer-compare/report.json', JSON.stringify(report, null, 2) + '\n');
  writeFileSync('artifacts/composer-compare/report.md', md + '\n');
  console.log(md.split('\n').slice(0, 12).join('\n'));
});
