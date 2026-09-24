/**
 * #133 — pure `composer-semantic-v3` cases over a small synthetic library shaped like the editorial
 * one. Each test names the product behavior it protects: cold-start doors, continuation after an
 * act, sourced bridges, credible challenge, the rolling exploration floor, no adjacent repeats,
 * the reader's correction, gates, starvation, fatigue, redundancy and deterministic replay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_V3_POLICY,
  composeSemantic,
  renderReason,
  type V3Asset,
  type V3State,
} from '../packages/core/src/composer/semantic.ts';

const concepts = new Map([
  ['physics', { code: 'physics', name: 'Physics', parentCode: null }],
  ['physics.gravity', { code: 'physics.gravity', name: 'Gravity', parentCode: 'physics' }],
  ['earth', { code: 'earth', name: 'Earth science', parentCode: null }],
  ['earth.tides', { code: 'earth.tides', name: 'Tides', parentCode: 'earth' }],
  ['earth.seasons', { code: 'earth.seasons', name: 'Seasons', parentCode: 'earth' }],
  ['earth.seasons.tilt', { code: 'earth.seasons.tilt', name: 'Axial tilt', parentCode: 'earth.seasons' }],
  ['astro', { code: 'astro', name: 'Astronomy', parentCode: null }],
  ['astro.orbit', { code: 'astro.orbit', name: 'Orbit', parentCode: 'astro' }],
  ['astro.orbit.ellipse', { code: 'astro.orbit.ellipse', name: 'Elliptical orbit', parentCode: 'astro.orbit' }],
  ['bio', { code: 'bio', name: 'Biology', parentCode: null }],
  ['bio.homeostasis', { code: 'bio.homeostasis', name: 'Homeostasis', parentCode: 'bio' }],
]);

const asset = (id: string, primary: string | null, source: string, claims: string[] = [], order = 0): V3Asset => ({
  assetId: id, title: `Scroll ${id}`, kind: 'Scroll', sourceKey: source, editorialOrder: order,
  primary, concepts: primary ? [{ code: primary, role: 'primary' }] : [], claimKeys: claims,
});

const library: V3Asset[] = [
  asset('gravity-1', 'physics.gravity', 'nasa.gravity', ['c.gravity.pull'], 1),
  asset('gravity-2', 'physics.gravity', 'nasa.gravity', ['c.gravity.orbits'], 2),
  asset('tides-1', 'earth.tides', 'noaa.tides', ['c.tides.cause'], 3),
  asset('seasons-1', 'earth.seasons', 'nasa.seasons', ['c.seasons.tilt'], 4),
  asset('tilt-1', 'earth.seasons.tilt', 'nasa.seasons', ['c.tilt.angle'], 5),
  asset('orbit-1', 'astro.orbit', 'nasa.orbits', ['c.orbit.path'], 6),
  asset('ellipse-1', 'astro.orbit.ellipse', 'nasa.orbits', ['c.orbit.ellipse'], 7),
  asset('body-1', 'bio.homeostasis', 'openstax.homeo', ['c.body.stable'], 8),
  asset('unmapped-1', null, 'demo.unmapped', [], 9),
];

const NOW = Date.parse('2026-09-24T12:00:00Z');
const HOUR = 3_600_000;

function state(over: Partial<V3State> = {}): V3State {
  return {
    nowMs: NOW, seed: 'u1:0', concepts, assets: library, kept: new Set(), exposures: new Map(), sourceExposures: new Map(),
    marks: [], served: [], accounts: new Map(),
    bridges: [{ id: 'b.gravity.tides', from: 'physics.gravity', to: 'earth.tides', symmetric: false, phraseForward: 'explains', phraseReverse: 'is explained by', fromName: 'Gravity', toName: 'Tides' }],
    contradictions: [{ from: 'astro.orbit.ellipse', to: 'earth.seasons', claimKey: 'c.seasons.tilt' }],
    openQuestionConcepts: [], directionPriors: [], suppressedRoutes: [], currentAssetId: null,
    ...over,
  };
}

const exposed = (...ids: string[]) => new Map(ids.map((id, i) => [id, { count: 1, lastAtMs: NOW - (ids.length - i) * HOUR }]));
const served = (...pairs: [string, V3State['served'][number]['family']][]) => pairs.map(([assetId, family], i) => ({ assetId, family, atMs: NOW - (i + 1) * HOUR }));

test('cold start offers one door per domain and nothing already seen', () => {
  const result = composeSemantic(state(), COMPOSER_V3_POLICY);
  assert.equal(result.selected[0]!.family, 'seed');
  const domains = new Set(result.selected.map(c => c.facts.domainName));
  assert.equal(domains.size, result.selected.length, 'each slot opens a different domain');
  assert.ok(result.candidates.some(c => c.family === 'fallback' && c.assetId === 'unmapped-1'), 'unmapped inventory is still recorded as a candidate');
});

test('after keeping a gravity Scroll, the next encounter continues or crosses a sourced bridge — and says which act led there', () => {
  const s = state({
    exposures: exposed('gravity-1'), served: served(['gravity-1', 'seed']),
    marks: [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep', atMs: NOW - HOUR }],
  });
  const result = composeSemantic(s, COMPOSER_V3_POLICY);
  const head = result.selected[0]!;
  assert.ok(['continue', 'bridge'].includes(head.family), head.family);
  const bridge = result.candidates.find(c => c.family === 'bridge' && c.assetId === 'tides-1')!;
  assert.equal(bridge.gate, null);
  assert.equal(renderReason('A sourced connection from “{{markTitle}}”: {{fromName}} {{relationPhrase}} {{toName}}.', bridge.facts),
    'A sourced connection from “Scroll gravity-1”: Gravity explains Tides.');
  assert.deepEqual(bridge.evidence.map(e => e.kind), ['mark', 'bridge']);
});

test('a reader who marked the elliptical-orbit idea is offered the source that says seasons come from tilt', () => {
  const s = state({ exposures: exposed('ellipse-1'), served: served(['ellipse-1', 'seed']), marks: [{ eventId: 'k2', assetId: 'ellipse-1', kind: 'keep', atMs: NOW - HOUR }] });
  const challenge = composeSemantic(s, COMPOSER_V3_POLICY).candidates.find(c => c.family === 'challenge');
  assert.equal(challenge?.assetId, 'seasons-1');
  assert.equal(challenge?.gate, null);
});

test('deepen offers a narrower idea of something the reader acted on', () => {
  const s = state({ exposures: exposed('seasons-1'), served: served(['seasons-1', 'seed']), marks: [{ eventId: 'b1', assetId: 'seasons-1', kind: 'branch', atMs: NOW - HOUR }] });
  const deepen = composeSemantic(s, COMPOSER_V3_POLICY).candidates.filter(c => c.family === 'deepen' && c.gate === null).map(c => c.assetId);
  assert.deepEqual(deepen, ['tilt-1']);
});

test('the exploration floor holds over the served sequence, not inside one slate', () => {
  const marks = [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep' as const, atMs: NOW - HOUR }];
  const notDue = composeSemantic(state({ exposures: exposed('gravity-1'), marks, served: served(['gravity-1', 'continue']) }), COMPOSER_V3_POLICY);
  assert.equal(notDue.window.explorationDue, false);
  const due = composeSemantic(state({ exposures: exposed('gravity-1', 'orbit-1'), marks, served: served(['gravity-1', 'continue'], ['orbit-1', 'continue']) }), COMPOSER_V3_POLICY);
  assert.equal(due.window.explorationDue, true);
  assert.ok(['bridge', 'frontier', 'challenge', 'revisit', 'fallback'].includes(due.selected[0]!.family));
  assert.match(due.quotas[0]!, /^exploration_floor:/);
});

test('the same idea is not served twice in a row unless the reader acted on it', () => {
  const noAct = composeSemantic(state({ exposures: exposed('gravity-1'), served: served(['gravity-1', 'seed']), marks: [{ eventId: 'k9', assetId: 'orbit-1', kind: 'keep', atMs: NOW - 90 * HOUR }] }), COMPOSER_V3_POLICY);
  const primaryOf = (id: string) => library.find(a => a.assetId === id)!.primary;
  assert.notEqual(primaryOf(noAct.selected[0]!.assetId), 'physics.gravity', 'no act on gravity: the next encounter changes idea');
  const acted = composeSemantic(state({ exposures: exposed('gravity-1'), served: served(['gravity-1', 'seed']), marks: [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep', atMs: NOW - HOUR }] }), COMPOSER_V3_POLICY);
  assert.ok(acted.candidates.some(c => c.family === 'continue' && c.assetId === 'gravity-2' && c.gate === null));
});

test('"less like this" suppresses exactly that route for this reader, and the record says so', () => {
  const s = state({
    exposures: exposed('gravity-1'), served: served(['gravity-1', 'seed']),
    marks: [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep', atMs: NOW - HOUR }],
    suppressedRoutes: [{ family: 'bridge', concept: 'earth.tides' }],
  });
  const result = composeSemantic(s, COMPOSER_V3_POLICY);
  assert.equal(result.candidates.find(c => c.family === 'bridge' && c.assetId === 'tides-1')!.gate, 'suppressed_by_person');
  assert.ok(!result.selected.some(c => c.family === 'bridge' && c.assetId === 'tides-1'));
});

test('kept and on-screen encounters are gated with named reasons; a seen one is ranked lower, never silently dropped', () => {
  const s = state({ kept: new Set(['tides-1']), exposures: exposed('orbit-1'), currentAssetId: 'body-1', served: served(['orbit-1', 'seed']) });
  const fallback = new Map(composeSemantic(s, COMPOSER_V3_POLICY).candidates.filter(c => c.family === 'fallback').map(c => [c.assetId, c]));
  assert.equal(fallback.get('tides-1')!.gate, 'kept');
  assert.equal(fallback.get('body-1')!.gate, 'current_encounter');
  // Exposure-aware reranking: seen is a recorded penalty, not a gate.
  assert.equal(fallback.get('orbit-1')!.gate, null);
  assert.ok(fallback.get('orbit-1')!.terms.seen! > 0 && fallback.get('ellipse-1')!.terms.seen === 0);
  assert.ok(fallback.get('orbit-1')!.score < fallback.get('ellipse-1')!.score);
});

function serveHeads(start: V3State, steps: number): { order: string[]; state: V3State } {
  let s = start;
  const order: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const head = composeSemantic(s, COMPOSER_V3_POLICY).selected[0];
    if (!head) break;
    order.push(head.assetId);
    const prior = s.exposures.get(head.assetId);
    s = { ...s, seed: `u1:${i + 1}`, nowMs: s.nowMs + HOUR,
      exposures: new Map([...s.exposures, [head.assetId, { count: (prior?.count ?? 0) + 1, lastAtMs: s.nowMs }]]),
      sourceExposures: new Map([...s.sourceExposures, [head.sourceKey, (s.sourceExposures.get(head.sourceKey) ?? 0) + 1]]),
      served: [{ assetId: head.assetId, family: head.family, atMs: s.nowMs }, ...s.served] };
  }
  return { order, state: s };
}

test('no encounter starves: the whole library is reached before anything returns, then the least-seen return first', () => {
  const first = serveHeads(state(), library.length);
  assert.deepEqual([...first.order].sort(), library.map(a => a.assetId).sort(), 'every Scroll once before any repeat');
  const second = serveHeads(first.state, library.length);
  assert.deepEqual([...second.order].sort(), library.map(a => a.assetId).sort(), 'a second pass also reaches every Scroll before a third showing');
});

test('no seen encounter outranks a less-seen one, however relevant — a revisit included', () => {
  // gravity-1 and tides-1 were seen four days ago; the reader has since kept gravity-2. gravity-1 is
  // now a revisit (same idea, acted on since) and tides-1 a sourced bridge target, and both still
  // wait behind every unseen Scroll.
  const long = NOW - 4 * 24 * HOUR;
  const s = state({
    kept: new Set(['gravity-2']),
    exposures: new Map([['gravity-1', { count: 1, lastAtMs: long }], ['tides-1', { count: 1, lastAtMs: long }], ['gravity-2', { count: 1, lastAtMs: NOW - 2 * HOUR }]]),
    marks: [{ eventId: 'e1', assetId: 'gravity-2', kind: 'keep', atMs: NOW - HOUR }],
    served: served(['gravity-2', null], ['tides-1', 'seed'], ['gravity-1', 'seed']),
  });
  const result = composeSemantic(s, COMPOSER_V3_POLICY);
  assert.ok(result.candidates.some(c => c.assetId === 'gravity-1' && c.family === 'revisit'), 'the revisit exists');
  assert.ok(result.candidates.some(c => c.assetId === 'tides-1' && c.family === 'bridge'), 'the bridge exists');
  const seenCount = (id: string) => s.exposures.get(id)?.count ?? 0;
  const ranked = result.selected;
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(seenCount(ranked[i - 1]!.assetId) <= seenCount(ranked[i]!.assetId), ranked.map(c => `${c.assetId}:${c.family}`).join(', '));
  }
  assert.ok(ranked.every(c => seenCount(c.assetId) === 0), 'unseen Scrolls fill the slate while any remain');
});

test('a reader skipping what they opened this session never meets a false end while less-seen Scrolls remain', () => {
  // Everything was seen once a day ago and gravity-1 was kept. A new session walks the feed and
  // skips whatever it already opened, as the Android client does (the review's second-pass case).
  const dayAgo = NOW - 24 * HOUR;
  // Several sourced connections lead on from the kept idea, so relevant Scrolls could fill a slate.
  const bridges = [...state().bridges,
    { id: 'b.gravity.orbit', from: 'physics.gravity', to: 'astro.orbit', symmetric: false, phraseForward: 'explains', phraseReverse: 'is explained by', fromName: 'Gravity', toName: 'Orbit' },
    { id: 'b.gravity.seasons', from: 'physics.gravity', to: 'earth.seasons', symmetric: false, phraseForward: 'shapes', phraseReverse: 'is shaped by', fromName: 'Gravity', toName: 'Seasons' }];
  let s = state({
    bridges,
    kept: new Set(['gravity-1']),
    exposures: new Map(library.map(a => [a.assetId, { count: 1, lastAtMs: dayAgo }])),
    marks: [{ eventId: 'e1', assetId: 'gravity-1', kind: 'keep', atMs: dayAgo }],
    served: library.map((a, i) => ({ assetId: a.assetId, family: null, atMs: dayAgo - i * 1000 })),
  });
  const visited = new Set<string>();
  const unkept = library.filter(a => a.assetId !== 'gravity-1').length;
  for (let step = 0; step < unkept; step += 1) {
    const slate = composeSemantic(s, COMPOSER_V3_POLICY).selected;
    const next = slate.find(c => !visited.has(c.assetId));
    assert.ok(next, `step ${step}: slate [${slate.map(c => c.assetId).join(', ')}] is all visited while ${unkept - visited.size} unkept remain`);
    visited.add(next.assetId);
    const prior = s.exposures.get(next.assetId)!;
    s = { ...s, seed: `u1:${step + 10}`, nowMs: s.nowMs + HOUR,
      exposures: new Map([...s.exposures, [next.assetId, { count: prior.count + 1, lastAtMs: s.nowMs }]]),
      served: [{ assetId: next.assetId, family: next.family, atMs: s.nowMs }, ...s.served] };
  }
  assert.equal(visited.size, unkept, 'every unkept Scroll was reached in the second pass');
});

test('only keeping everything exhausts the library, as the established contract says', () => {
  const seenAll = serveHeads(state(), library.length).state;
  assert.ok(composeSemantic(seenAll, COMPOSER_V3_POLICY).selected.length > 0, 'having seen everything is not the end');
  const keptAll = { ...seenAll, kept: new Set(library.map(a => a.assetId)) };
  assert.equal(composeSemantic(keptAll, COMPOSER_V3_POLICY).selected.length, 0, 'an exhausted library returns nothing, not a repeat');
});

test('fatigue and redundant arguments lower a candidate, and the terms are recorded', () => {
  const s = state({
    exposures: exposed('gravity-1'),
    served: [{ assetId: 'gravity-1', family: 'continue', atMs: NOW - HOUR }],
    assets: [...library, { ...asset('gravity-3', 'physics.gravity', 'nasa.gravity', ['c.gravity.pull'], 10) }],
    marks: [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep', atMs: NOW - HOUR }],
  });
  const c = composeSemantic(s, COMPOSER_V3_POLICY).candidates.find(x => x.assetId === 'gravity-3' && x.family === 'continue')!;
  assert.equal(c.terms.redundancy, 0.6, 'same claim already served in the window');
  assert.equal(c.terms.fatigue, 0.15);
});

test('a concept the feed mostly offered cannot earn more than the saturated useful term', () => {
  const s = state({ accounts: new Map([['physics.gravity', { mass: 50, exposureShare: 0.95 }]]) });
  const c = composeSemantic(s, COMPOSER_V3_POLICY).candidates.find(x => x.assetId === 'gravity-2')!;
  assert.ok(c.terms.useful! <= 0.5);
});

test('the same recorded state always yields the same slate and records (replay)', () => {
  const s = state({ exposures: exposed('gravity-1'), served: served(['gravity-1', 'seed']), marks: [{ eventId: 'k1', assetId: 'gravity-1', kind: 'keep', atMs: NOW - HOUR }] });
  const a = composeSemantic(s, COMPOSER_V3_POLICY);
  // Round-trip through JSON exactly as a recorded snapshot would be stored, restoring only the
  // top-level collections.
  const wire = JSON.parse(JSON.stringify({ ...s, concepts: [...s.concepts], kept: [...s.kept], exposures: [...s.exposures], sourceExposures: [...s.sourceExposures], accounts: [...s.accounts] }));
  const restored: V3State = { ...wire, concepts: new Map(wire.concepts), kept: new Set(wire.kept), exposures: new Map(wire.exposures), sourceExposures: new Map(wire.sourceExposures), accounts: new Map(wire.accounts) };
  const b = composeSemantic(restored, COMPOSER_V3_POLICY);
  assert.deepEqual(b, a);
});
