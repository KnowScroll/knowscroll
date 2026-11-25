import { describe, expect, it } from 'vitest';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { storedOrrinV2 } from '../production/orrin.fixture.js';
import { coverageTargetOfV2 } from './coverage-target-v2.js';

/** The nine drawing kits a stored stage may name; none is defined by any code any more (#799 to #835). */
const RETIRED_KITS = [
  'transit.v1',
  'tides.v1',
  'star.v1',
  'greenhouse.v1',
  'circulation.v1',
  'nerve.v1',
  'black-hole.v1',
  'starlight.v1',
  'earth-sky.v1',
] as const;

const assetId = '0199a000-0000-7000-8000-0000000000a1';
const explanationUnitId = 'ci-stored-stage';

/**
 * The coverage target of a stored v2 revision does not depend on what its stage once drew: the revision is admitted again from its
 * stored bytes (the stage passes through, #835), and the reading units are its stops. The revision is the labelled Orrin snapshot,
 * whose stage is Earth & sky's, with its stage rewritten to name each retired kit.
 */
function rowOf(kit: string | undefined) {
  const stored = storedOrrinV2({
    assetId,
    explanationUnitId,
    edit: (document) => {
      if (kit === undefined) return;
      const stage = document.stage;
      if (stage === undefined) throw new Error('the snapshot has a stage');
      (document as { stage: unknown }).stage = { kit, states: stage.states };
    },
  });
  const document = stored.document as unknown as ScrollDocumentV2;
  return {
    row: {
      document: stored.document,
      document_sha256: document.integrity.sha256,
      explanation_unit_id: explanationUnitId,
      provenance_kind: 'generated',
      provenance_version: stored.provenanceVersion,
      provenance: stored.provenance,
    },
    document,
  };
}

describe('the coverage target of a stored v2 revision with a stage of a kit no code draws', () => {
  it('is the stored Earth & sky stage as the snapshot holds it: a target with one block for each stop', () => {
    const { row, document } = rowOf(undefined);
    expect(document.stage?.kit).toBe('earth-sky.v1');
    const target = coverageTargetOfV2(row, { assetId, assetRevision: 1 });
    expect(target).toBeDefined();
    expect(target?.blocks.map((block) => block.id)).toEqual(document.stops.map((stop) => stop.id));
  });

  it.each(RETIRED_KITS)('is the same target for a stage naming %s', (kit) => {
    const base = coverageTargetOfV2(rowOf(undefined).row, { assetId, assetRevision: 1 });
    const { row } = rowOf(kit);
    const target = coverageTargetOfV2(row, { assetId, assetRevision: 1 });
    expect(target).toBeDefined();
    // The facts depend on the stops and their words, not on the stage: only the document hash differs, as the stage is in it.
    expect(target?.blocks).toEqual(base?.blocks);
    expect(target?.readingFactsSha256).toBe(base?.readingFactsSha256);
    expect(target?.readingFactsVersion).toBe(base?.readingFactsVersion);
  });

  it('is nothing for a stage whose kit is not the form of one, as for any document that does not admit', () => {
    const { row } = rowOf('constructor');
    expect(coverageTargetOfV2(row, { assetId, assetRevision: 1 })).toBeUndefined();
  });
});
