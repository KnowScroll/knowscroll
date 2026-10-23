import { describe, expect, it } from 'vitest';
import {
  diversify,
  opportunityIssue,
  OpportunitySchema,
  ProposalSchema,
  type Opportunity,
  type ValidationFacts,
} from './proposal.js';
const facts: ValidationFacts = {
  evaluatedAt: '2026-10-20T12:00:00Z',
  topics: ['a', 'b', 'c'],
  evidence: ['a', 'b', 'c'].map((t) => ({ ref: `e:${t}`, explanationUnitId: `unit-${t}`, topicIds: [t] })),
  inventory: [],
  hiddenAssetIds: [],
  encounteredUnitIds: [],
};
function candidate(t = 'a', move: Opportunity['move'] = 'limitation'): Opportunity {
  return {
    move,
    title: 'Authored CI fixture',
    purpose: 'A proposed next explanatory move; not provider output.',
    topicIds: [t],
    explanationUnitId: `unit-${t}`,
    evidenceRefs: [`e:${t}`],
    eligibility: ['vertical'],
    formats: ['scroll'],
    expiresAt: '2026-10-21T12:00:00Z',
    target: { kind: 'missing_supply', brief: 'An unadmitted limitation proposal.' },
  };
}
describe('Planner deterministic proposal boundary (authored CI fixtures)', () => {
  it('accepts a supported bounded unadmitted proposal without asserting learning or completed production', () => {
    expect(ProposalSchema.safeParse({ version: 'planner-proposal.v0', opportunities: [candidate()] }).success).toBe(
      true,
    );
    expect(opportunityIssue(candidate(), facts)).toBeUndefined();
    expect(
      ProposalSchema.safeParse({ version: 'planner-proposal.v0', opportunities: [], evidenceGrowth: 1 }).success,
    ).toBe(false);
    expect(
      ProposalSchema.safeParse({ version: 'planner-proposal.v0', opportunities: Array(7).fill(candidate()) }).success,
    ).toBe(false);
  });
  it('refuses foreign and provisional references, invented units/topics and duplicate references', () => {
    expect(opportunityIssue({ ...candidate(), evidenceRefs: ['routing_only:foreign'] }, facts)).toBe(
      'evidence_authority',
    );
    expect(opportunityIssue({ ...candidate(), topicIds: ['b'] }, facts)).toBe('evidence_authority');
    expect(opportunityIssue({ ...candidate(), topicIds: ['foreign'] }, facts)).toBe('unknown_topic');
    expect(opportunityIssue({ ...candidate(), explanationUnitId: 'model-invented' }, facts)).toBe('target_authority');
    expect(opportunityIssue({ ...candidate(), explanationUnitId: 'unit-b' }, facts)).toBe('target_authority');
    expect(opportunityIssue({ ...candidate(), formats: ['scroll', 'scroll'] }, facts)).toBe('duplicate_reference');
  });
  it('requires a future expiry within seven days and exact eligible current asset authority', () => {
    for (const expiresAt of ['2026-10-20T12:00:00Z', '2026-10-29T12:00:00Z'])
      expect(opportunityIssue({ ...candidate(), expiresAt }, facts)).toBe('expiry');
    const asset = {
      assetId: '00000000-0000-4000-8000-000000000001',
      assetRevision: 2,
      catalogWatermark: 'actual-revision',
      explanationUnitId: 'unit-a',
      kind: 'scroll' as const,
      topicIds: ['a'],
    };
    const x = {
      ...candidate(),
      target: {
        kind: 'existing' as const,
        assetId: asset.assetId,
        assetRevision: 2,
        catalogWatermark: asset.catalogWatermark,
      },
    };
    expect(opportunityIssue(x, { ...facts, inventory: [asset] })).toBeUndefined();
    expect(opportunityIssue(x, { ...facts, inventory: [{ ...asset, assetRevision: 3 }] })).toBe('target_authority');
    expect(opportunityIssue(x, { ...facts, inventory: [asset], hiddenAssetIds: [asset.assetId] })).toBe(
      'target_authority',
    );
    expect(opportunityIssue({ ...x, formats: ['reel'] }, { ...facts, inventory: [asset] })).toBe('target_authority');
  });
  it('refuses an existing target the person has already read, but allows missing supply built on it', () => {
    const asset = {
      assetId: '00000000-0000-4000-8000-000000000001',
      assetRevision: 2,
      catalogWatermark: 'actual-revision',
      explanationUnitId: 'unit-a',
      kind: 'scroll' as const,
      topicIds: ['a'],
    };
    const existing = {
      ...candidate(),
      target: {
        kind: 'existing' as const,
        assetId: asset.assetId,
        assetRevision: 2,
        catalogWatermark: 'actual-revision',
      },
    };
    const read = { ...facts, inventory: [asset], encounteredUnitIds: ['unit-a'] };
    expect(opportunityIssue(existing, read)).toBe('already_encountered');
    expect(opportunityIssue(candidate(), read)).toBeUndefined();
  });
  it('keeps at most three with distinct units and bounded move/topic repetition', () => {
    const a = candidate(),
      b = candidate('b', 'mechanism'),
      c = candidate('c', 'perspective');
    expect(diversify([a, a, b, c, c])).toEqual([a, b, c]);
    expect(diversify([a, { ...a, explanationUnitId: 'other' }, { ...a, explanationUnitId: 'third' }])).toHaveLength(2);
  });
  it('bounds free text and rejects unsupported relationship kinds and model actions', () => {
    expect(OpportunitySchema.safeParse({ ...candidate(), eligibility: ['series_step'] }).success).toBe(false);
    expect(OpportunitySchema.safeParse({ ...candidate(), purpose: 'x'.repeat(401) }).success).toBe(false);
    expect(
      OpportunitySchema.safeParse({ ...candidate(), target: { kind: 'commission', brief: 'spend' } }).success,
    ).toBe(false);
  });
});
