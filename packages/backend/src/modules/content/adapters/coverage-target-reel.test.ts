import { describe, expect, it } from 'vitest';
import {
  coverageTargetOfReel,
  twinClaimsSupported,
  type StoredReelRevision,
  type StoredTwinRevision,
} from './coverage-target-reel.js';

const ref = { assetId: '6f1c2b0e-3d6a-4a53-9a8a-0f4a1c9b2d11', assetRevision: 1 };
const twinAsset = { assetId: '7a2d3c1f-4e7b-4b64-8b9b-1a5b2d0c3e22', assetRevision: 3 };
const unit = 'fixture-unit';
const durationMs = 30_000;
const sentences = ['One two three four.', 'Five six.', 'Seven eight nine.', 'Ten eleven.'];

const brief = {
  version: 1,
  worldId: 'fixture-world',
  narration: sentences.map((text, index) => ({ text, claimIds: [`c${String(index + 1)}`] })),
  claims: sentences.map((_, index) => ({ id: `c${String(index + 1)}`, role: 'supporting' })),
  claimSources: sentences.map((_, index) => ({ claimId: `c${String(index + 1)}`, ...twinAsset })),
  criteria: { mustShow: [], mustNotShow: [], depictionPolicyVersion: 'policy-3' },
  style: { id: 'style', version: 1, text: 'plain' },
  title: 'Fixture',
  summary: 'Fixture',
};
const reel = (over: Partial<StoredReelRevision> = {}): StoredReelRevision => ({
  document: {
    schemaVersion: 'reel-document.v1',
    assetId: ref.assetId,
    revision: 1,
    title: 'Fixture',
    summary: 'Fixture',
    language: 'en',
    truthLabel: 'generated',
    fixture: false,
    captions: 'burned_in',
    mediaKey: `sha256/ab/${'a'.repeat(64)}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
  },
  document_sha256: 'b'.repeat(64),
  explanation_unit_id: unit,
  provenance_kind: 'cutroom_import',
  provenance_version: 'reel-provenance.v1',
  provenance: {
    schemaVersion: 'reel-provenance.v1',
    kind: 'cutroom_import',
    fixture: false,
    recipe: 'fixture-recipe',
    brief,
    twin: { ...twinAsset, explanationUnitId: unit },
  },
  reading_facts: {
    v: 2,
    reelDurationMs: durationMs,
    measuresVersion: 'reel-duration.v1',
    totalWeight: 0,
    estimatedReadingMs: durationMs,
    blocks: [],
    nested: [],
  },
  ...over,
});
const twin = (claims: { claimId: string; truthState: string }[] = [], over: Partial<StoredTwinRevision> = {}) => ({
  explanation_unit_id: unit,
  framing_kind: 'factual',
  provenance: { schemaVersion: 'scroll-provenance.v1', claims },
  ...over,
});
const claim = (truthState: string, claimId = 'claim-1') => ({ claimId, truthState });

describe('the claims a Reel’s twin makes decide whether a Reel’s segments are supported (#674, slice 5.1)', () => {
  it('supports a twin whose every claim is documented or a synthesis, and one that makes no claim, as the Scroll rule does', () => {
    expect(twinClaimsSupported({ claims: [claim('documented'), claim('synthesis', 'claim-2')] })).toBe(true);
    expect(twinClaimsSupported({ claims: [] })).toBe(true);
  });

  it.each(['interpretation', 'disputed', 'modelled', 'counterfactual', 'fictional', 'unknown', ''])(
    'supports nothing when a claim of the twin is %j',
    (truthState) => {
      expect(twinClaimsSupported({ claims: [claim('documented'), claim(truthState, 'claim-2')] })).toBe(false);
    },
  );

  it('supports nothing from a provenance that does not list its claims', () => {
    for (const provenance of [undefined, null, {}, { claims: 'documented' }, { claims: [{ claimId: 'x' }] }])
      expect(twinClaimsSupported(provenance)).toBe(false);
  });

  it('makes every segment truth-supported for a documented twin, and none for a twin with an interpretation', () => {
    const supported = coverageTargetOfReel(reel(), twin([claim('documented')]), ref);
    expect(supported?.format).toBe('reel');
    expect(supported?.blocks.map((block) => block.truthSupported)).toEqual([true, true, true, true]);
    const unsupported = coverageTargetOfReel(
      reel(),
      twin([claim('documented'), claim('interpretation', 'claim-2')]),
      ref,
    );
    expect(unsupported?.blocks).toHaveLength(4);
    expect(unsupported?.blocks.map((block) => block.truthSupported)).toEqual([false, false, false, false]);
  });

  it('has no target when the twin is not served as a factual Scroll of the Reel’s unit, or the Reel is a fixture', () => {
    expect(coverageTargetOfReel(reel(), undefined, ref)).toBeUndefined();
    expect(coverageTargetOfReel(reel(), twin([], { framing_kind: 'hypothetical' }), ref)).toBeUndefined();
    expect(coverageTargetOfReel(reel(), twin([], { framing_kind: null }), ref)).toBeUndefined();
    expect(coverageTargetOfReel(reel(), twin([], { explanation_unit_id: 'another-unit' }), ref)).toBeUndefined();
    const fixture = reel();
    expect(
      coverageTargetOfReel({ ...fixture, document: { ...(fixture.document as object), fixture: true } }, twin(), ref),
    ).toBeUndefined();
  });
});
