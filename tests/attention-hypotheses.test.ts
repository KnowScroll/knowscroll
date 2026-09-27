/**
 * #131 — attention accounts and rule hypotheses (pure). Behavior is evidence of attention only:
 * watching never anchors a concept, voluntary acts on separate days from separate sources do, mass
 * decays while counts remain, a reader's correction contests a hypothesis and suspends its uses,
 * and no statement may characterize the person.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ATTENTION_V1, computeAttentionAccounts, decayedMass, type EpisodeEvidence } from '../packages/core/src/semantic/attention.ts';
import { proposeHypotheses, validateHypothesis, type HypothesisProposal, type RuleInputs } from '../packages/core/src/semantic/hypotheses.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const ep = (id: string, daysAgo: number, family: string | null, marks: EpisodeEvidence['marks'] = [], systemOffered = true, code = 'physics.gravity'): EpisodeEvidence => ({
  exposureId: id, atMs: NOW - daysAgo * DAY, assetId: `a-${id}`, concepts: [{ code, role: 'primary' }, { code: 'physics', role: 'secondary' }],
  familyKey: family, systemOffered, marks,
});
const mark = (id: string, kind: 'keep' | 'branch' | 'ask', daysAgo: number) => ({ eventId: id, kind, atMs: NOW - daysAgo * DAY });

test('watching alone never anchors, however much is watched', () => {
  const watched = Array.from({ length: 40 }, (_, i) => ep(`w${i}`, i % 5, i % 2 ? 'fam.nasa' : 'fam.noaa'));
  const account = computeAttentionAccounts(watched, [], NOW).get('physics.gravity')!;
  assert.equal(account.voluntary, 0);
  assert.equal(account.state, 'seen');
  assert.ok(account.mass > ATTENTION_V1.anchored.mass, 'mass alone can be high');
});

test('voluntary acts on separate days from separate source families anchor a concept', () => {
  const account = computeAttentionAccounts([
    ep('e1', 3, 'fam.nasa', [mark('k1', 'keep', 3)]),
    ep('e2', 2, 'fam.noaa', [mark('b1', 'branch', 2), mark('q1', 'ask', 2)]),
    ep('e3', 1, 'fam.nasa', [mark('k2', 'keep', 1)]),
  ], [], NOW).get('physics.gravity')!;
  assert.deepEqual([account.episodes, account.voluntary, account.daysActive, account.sourceFamilies], [3, 4, 3, 2]);
  assert.equal(account.returns, 2, 'each later day with an act is a separated return');
  assert.equal(account.state, 'anchored');
  assert.deepEqual(account.evidence.markIds, ['k1', 'b1', 'q1', 'k2']);
});

test('secondary concepts receive half credit, and a single source family cannot anchor', () => {
  const accounts = computeAttentionAccounts([
    ep('e1', 3, 'fam.nasa', [mark('k1', 'keep', 3)]), ep('e2', 2, 'fam.nasa', [mark('k2', 'keep', 2)]), ep('e3', 1, 'fam.nasa', [mark('k3', 'keep', 1)]),
  ], [], NOW);
  assert.equal(accounts.get('physics.gravity')!.state, 'seen', 'one family is not independent evidence');
  assert.ok(Math.abs(accounts.get('physics')!.mass - accounts.get('physics.gravity')!.mass / 2) < 1e-3);
});

test('mass decays with the half-life; counts do not', () => {
  const fresh = computeAttentionAccounts([ep('e1', 0, 'fam.nasa', [mark('k1', 'keep', 0)])], [], NOW).get('physics.gravity')!;
  const old = computeAttentionAccounts([ep('e1', 21, 'fam.nasa', [mark('k1', 'keep', 21)])], [], NOW).get('physics.gravity')!;
  assert.ok(Math.abs(old.mass - fresh.mass / 2) < 1e-3);
  assert.equal(old.voluntary, fresh.voluntary);
  assert.ok(Math.abs(decayedMass(8, 0, 42 * DAY, 21) - 2) < 1e-9);
});

function inputs(over: Partial<RuleInputs> = {}): RuleInputs {
  const episodes = [ep('e1', 3, 'fam.nasa', [mark('k1', 'keep', 3)]), ep('e2', 1, 'fam.noaa', [mark('k2', 'keep', 1)], false)];
  return {
    nowMs: NOW,
    accounts: computeAttentionAccounts(episodes, [], NOW),
    conceptNames: new Map([['physics.gravity', 'Gravity'], ['physics', 'Physics']]),
    marks: [
      { eventId: 'k1', atMs: NOW - 3 * DAY, assetId: 'a-e1', exposureId: 'e1', concepts: ['physics.gravity', 'physics'] },
      { eventId: 'k2', atMs: NOW - DAY, assetId: 'a-e2', exposureId: 'e2', concepts: ['physics.gravity', 'physics'] },
    ],
    offeredEpisodes: new Map([['physics.gravity', ['e1']]]),
    asks: [], feedback: [],
    ...over,
  };
}

test('a direction hypothesis cites its acts, states a competing alternative and may only stage encounters', () => {
  const direction = proposeHypotheses(inputs()).find(h => h.kind === 'direction' && h.concept === 'physics.gravity')!;
  assert.equal(direction.statement, 'Recent voluntary acts gather around Gravity.');
  assert.deepEqual(direction.evidence.map(e => e.ref), ['k1', 'k2']);
  assert.ok(direction.alternatives.length >= 1);
  assert.deepEqual(direction.permittedUses, ['composer.family_prior']);
  assert.equal(direction.status, 'active');
});

test('a reader\'s correction contests the hypothesis and suspends every permitted use', () => {
  const contested = proposeHypotheses(inputs({ feedback: [{ ref: 'f1', atMs: NOW - DAY, concepts: ['physics.gravity'] }] }))
    .find(h => h.kind === 'direction' && h.concept === 'physics.gravity')!;
  assert.equal(contested.status, 'contested');
  assert.deepEqual(contested.permittedUses, []);
  assert.deepEqual(contested.counterevidence, [{ kind: 'feedback', ref: 'f1' }]);
});

test('an old direction decays and loses its uses, but its record remains', () => {
  const old = inputs({ nowMs: NOW + 20 * DAY });
  const decayed = proposeHypotheses(old).find(h => h.kind === 'direction' && h.concept === 'physics.gravity')!;
  assert.equal(decayed.status, 'decayed');
  assert.deepEqual(decayed.permittedUses, []);
});

test('an open question stays until resolved and only asks for continuity', () => {
  const [q] = proposeHypotheses(inputs({ asks: [{ askEventId: 'ask1', exposureId: 'e2', atMs: NOW - DAY, concept: 'physics.gravity', resolved: false }] })).filter(h => h.kind === 'open_question');
  assert.equal(q!.status, 'active');
  assert.deepEqual(q!.permittedUses, ['composer.continuity']);
  const [resolved] = proposeHypotheses(inputs({ asks: [{ askEventId: 'ask1', exposureId: 'e2', atMs: NOW - DAY, concept: 'physics.gravity', resolved: true }] })).filter(h => h.kind === 'open_question');
  assert.equal(resolved!.status, 'decayed');
});

test('the validator refuses character claims, missing alternatives, unknown evidence and uses a model may not hold', () => {
  const good = proposeHypotheses(inputs()).find(h => h.kind === 'direction' && h.concept === 'physics.gravity')!;
  const known = new Set(['mark:k1', 'mark:k2', 'exposure:e1', 'exposure:e2']);
  const ctx = { proposer: 'rule' as const, knownEvidence: known, knownConcepts: new Set(['physics.gravity', 'physics']) };
  assert.deepEqual(validateHypothesis(good, ctx), { ok: true });
  const bad = (p: Partial<HypothesisProposal>, c: Parameters<typeof validateHypothesis>[1] = ctx) => { const r = validateHypothesis({ ...good, ...p }, c); return r.ok ? [] : r.reasons; };
  assert.ok(bad({ statement: 'You are fascinated by gravity.' }).includes('statement_characterizes_person'));
  assert.ok(bad({ statement: 'The reader has mastered orbital mechanics.' }).includes('statement_characterizes_person'));
  assert.ok(bad({ alternatives: [] }).includes('alternative_missing'));
  assert.ok(bad({ evidence: [{ kind: 'mark', ref: 'invented' }] }).includes('evidence_unresolved'));
  assert.ok(bad({}, { ...ctx, proposer: 'model' }).includes('use_not_permitted'), 'a model may not claim a ranking prior');
  assert.ok(bad({ kind: 'identity' as never }).includes('kind_prohibited'));
});
