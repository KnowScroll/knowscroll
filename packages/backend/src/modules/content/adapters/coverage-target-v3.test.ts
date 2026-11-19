import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import seasons from '../fixtures/document-v3/seasons.editorial-scroll-v3.json' with { type: 'json' };
import type { CoverageRef } from '../domain/coverage.js';
import { coverageTargetOfV3 } from './coverage-target-v3.js';
import type { StoredRevisionV2 } from './coverage-target-v2.js';
import { compileEditorialSourceV3 } from './scroll-compiler-v3.js';

const compiled = compileEditorialSourceV3(seasons, 1);
if (compiled.kind !== 'compiled') throw new Error('the seasons fixture must compile');
const ref: CoverageRef = { assetId: seasons.assetId, assetRevision: 1 };

/** The row the coverage store reads for the hand-written seasons Scroll. */
const authoredRow: StoredRevisionV2 = {
  document: compiled.document,
  document_sha256: compiled.documentSha256,
  explanation_unit_id: compiled.explanationUnitId,
  provenance_kind: 'authored_editorial',
  provenance_version: 'scroll-provenance.v3',
  provenance: compiled.provenance,
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const provenanceOf = (row: StoredRevisionV2) => row.provenance as Record<string, unknown> & { claims: Claim[] };
interface Claim {
  claimId: string;
  truthState: string;
}

describe('the coverage target of a stored scroll-document.v3 revision', () => {
  it('reads an authored editorial Scroll whose document, provenance and row agree, with one beat unit per beat', () => {
    const target = coverageTargetOfV3(authoredRow, ref);
    expect(target).toMatchObject({
      documentSha256: compiled.documentSha256,
      provenanceSha256: canonicalSha256(authoredRow.provenance),
      explanationUnitId: 'fixture-v3-seasons',
      framing: 'factual',
      readingFactsVersion: 4,
    });
    expect(target?.blocks).toHaveLength(12);
    expect(target?.blocks.every((block) => block.type === 'beat' && !block.nested)).toBe(true);
    expect(target?.blocks.map((block) => block.id)).toEqual(compiled.readingFacts.blocks.map((block) => block.id));
    expect(target?.readingFactsSha256).toBe(canonicalSha256(compiled.readingFacts));
  });

  it('marks every beat of the documented fixture truth-supported', () => {
    expect(coverageTargetOfV3(authoredRow, ref)?.blocks.every((block) => block.truthSupported)).toBe(true);
  });

  it('reads a model-produced Scroll just as well, under its own lineage pair (generated, model)', () => {
    const row = clone(authoredRow);
    provenanceOf(row)['production'] = {
      kind: 'model',
      runId: 'run-1',
      attemptIds: ['attempt-1'],
      model: 'MiniMax-M3.1-Flash',
      promptVersion: 'fixture-prompt',
    };
    expect(coverageTargetOfV3({ ...row, provenance_kind: 'generated' }, ref)?.blocks).toHaveLength(12);
  });

  it('keeps a beat out of the supported set when a claim it cites is not documented or a synthesis', () => {
    const row = clone(authoredRow);
    // b4 cites only b-tilt-season, which b5 and b12 cite too: all three must lose support, and no other beat.
    const claim = provenanceOf(row).claims.find((entry) => entry.claimId === 'b-tilt-season');
    if (claim === undefined) throw new Error('fixture shape');
    claim.truthState = 'interpretation';
    const unsupported = coverageTargetOfV3(row, ref)
      ?.blocks.filter((block) => !block.truthSupported)
      .map((block) => block.id);
    expect(unsupported).toEqual(['b4', 'b5', 'b12']);
  });

  it('accepts a beat that cites a synthesis', () => {
    const row = clone(authoredRow);
    const claim = provenanceOf(row).claims.find((entry) => entry.claimId === 'b-tilt-season');
    if (claim === undefined) throw new Error('fixture shape');
    claim.truthState = 'synthesis';
    expect(coverageTargetOfV3(row, ref)?.blocks.every((block) => block.truthSupported)).toBe(true);
  });

  it('keeps a beat out of the supported set when it cites no claim', () => {
    const row = clone(authoredRow);
    const citations = (provenanceOf(row) as unknown as { citations: { partId: string }[] }).citations;
    citations.splice(
      citations.findIndex((entry) => entry.partId === 'b1'),
      1,
    );
    const target = coverageTargetOfV3(row, ref);
    expect(target?.blocks.find((block) => block.id === 'b1')?.truthSupported).toBe(false);
    expect(target?.blocks.find((block) => block.id === 'b2')?.truthSupported).toBe(true);
  });

  describe('is undefined when the revision, its provenance and its lineage do not agree', () => {
    it('for a provenance kind that does not go with the production record', () => {
      expect(coverageTargetOfV3({ ...authoredRow, provenance_kind: 'generated' }, ref)).toBeUndefined();
      const modelled = clone(authoredRow);
      provenanceOf(modelled)['production'] = {
        kind: 'model',
        runId: 'run-1',
        attemptIds: ['attempt-1'],
        model: 'MiniMax-M3.1-Flash',
        promptVersion: 'fixture-prompt',
      };
      expect(coverageTargetOfV3(modelled, ref)).toBeUndefined();
    });

    it('for a fixture production record, which has no lineage here', () => {
      const row = clone(authoredRow);
      provenanceOf(row)['production'] = { kind: 'fixture', label: 'test data' };
      expect(coverageTargetOfV3({ ...row, provenance_kind: 'fixture' }, ref)).toBeUndefined();
    });

    it('for a stored provenance version other than the record’s', () => {
      expect(coverageTargetOfV3({ ...authoredRow, provenance_version: 'scroll-provenance.v2' }, ref)).toBeUndefined();
    });

    it('for a stored document hash that is not the document’s', () => {
      expect(coverageTargetOfV3({ ...authoredRow, document_sha256: 'c'.repeat(64) }, ref)).toBeUndefined();
    });

    it('for a provenance that belongs to another document hash', () => {
      const row = clone(authoredRow);
      provenanceOf(row)['documentSha256'] = 'c'.repeat(64);
      expect(coverageTargetOfV3(row, ref)).toBeUndefined();
    });

    it('for another asset or another revision than the one asked for', () => {
      expect(
        coverageTargetOfV3(authoredRow, { ...ref, assetId: 'b098225b-8bd8-4611-9866-b03b8020c70e' }),
      ).toBeUndefined();
      expect(coverageTargetOfV3(authoredRow, { ...ref, assetRevision: 2 })).toBeUndefined();
    });

    it('for a provenance of another asset or revision', () => {
      const otherAsset = clone(authoredRow);
      provenanceOf(otherAsset)['assetId'] = 'b098225b-8bd8-4611-9866-b03b8020c70e';
      expect(coverageTargetOfV3(otherAsset, ref)).toBeUndefined();
      const otherRevision = clone(authoredRow);
      provenanceOf(otherRevision)['revision'] = 2;
      expect(coverageTargetOfV3(otherRevision, ref)).toBeUndefined();
    });

    it('for an explanation unit that is not the document’s', () => {
      expect(coverageTargetOfV3({ ...authoredRow, explanation_unit_id: 'another-unit' }, ref)).toBeUndefined();
    });

    it('for a document that is not factual, with its hash, its row and its provenance all sealed to match', () => {
      // Resealed on purpose: with the integrity hash left stale the document would fail admission for that reason
      // and the framing rule would never be reached.
      const resealed = (framing: unknown): StoredRevisionV2 => {
        const row = clone(authoredRow);
        const document = row.document as Record<string, unknown>;
        document['framing'] = framing;
        const sha256 = canonicalSha256({ ...document, integrity: undefined });
        document['integrity'] = { method: (document['integrity'] as { method: string }).method, sha256 };
        provenanceOf(row)['documentSha256'] = sha256;
        return { ...row, document_sha256: sha256 };
      };
      expect(coverageTargetOfV3(resealed({ kind: 'factual' }), ref)).toBeDefined();
      expect(coverageTargetOfV3(resealed({ kind: 'perspective', lens: 'a ship’s carpenter' }), ref)).toBeUndefined();
      expect(
        coverageTargetOfV3(resealed({ kind: 'hypothetical', assumptions: ['No axial tilt'], kept: [] }), ref),
      ).toBeUndefined();
    });

    it('for a document that is not a valid document v3, and for provenance that is not a valid record', () => {
      expect(
        coverageTargetOfV3({ ...authoredRow, document: { schemaVersion: 'scroll-document.v3' } }, ref),
      ).toBeUndefined();
      expect(
        coverageTargetOfV3({ ...authoredRow, provenance: { schemaVersion: 'scroll-provenance.v3' } }, ref),
      ).toBeUndefined();
      expect(coverageTargetOfV3({ ...authoredRow, provenance: null }, ref)).toBeUndefined();
    });
  });
});
