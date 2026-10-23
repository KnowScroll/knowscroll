import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS, CONCEPT_CATALOGUE_VERSION, conceptMeaning } from './concepts.js';
import {
  COVERAGE_POLICY,
  CoverageCommandSchema,
  CoverageMappingSchema,
  currentCoverageMapping,
  validateCoverageMapping,
  type CoverageMapping,
  type CoverageTarget,
} from './coverage.js';

const hash = 'a'.repeat(64);
const target: CoverageTarget = {
  documentSha256: hash,
  provenanceSha256: hash,
  explanationUnitId: 'fixture-only-unit',
  framing: 'factual',
  framingSha256: hash,
  readingFactsVersion: 2,
  readingFactsSha256: hash,
  blocks: [{ id: 'fixture-paragraph', type: 'paragraph', nested: false, truthSupported: true }],
};
const catalogue = { sha256: hash, meaningSha256: () => hash };
function mapping(): CoverageMapping {
  return {
    version: COVERAGE_POLICY,
    documentSha256: hash,
    provenanceSha256: hash,
    explanationUnitId: target.explanationUnitId,
    framing: 'factual',
    framingSha256: hash,
    readingFactsVersion: 2,
    readingFactsSha256: hash,
    catalogueVersion: CONCEPT_CATALOGUE_VERSION,
    catalogueSha256: hash,
    bindings: [
      {
        topicId: 'earth.seasons',
        facetId: 'earth.seasons.axial-tilt',
        meaningSha256: hash,
        requiredBlockIds: ['fixture-paragraph'],
      },
    ],
  };
}
describe('Content static coverage admission, synthetic source fixtures only', () => {
  it('has explicit immutable meanings and parent relationships, without a map or personal evidence', () => {
    expect(Object.isFrozen(CONCEPTS)).toBe(true);
    for (const topic of CONCEPTS) {
      expect(Object.isFrozen(topic)).toBe(true);
      expect(Object.isFrozen(topic.facets)).toBe(true);
      if (topic.parent !== null) expect(CONCEPTS.some((parent) => parent.id === topic.parent)).toBe(true);
    }
    expect(conceptMeaning('earth.seasons', 'earth.seasons.axial-tilt')).toBeDefined();
    expect(conceptMeaning('earth', 'earth.seasons.axial-tilt')).toBeUndefined();
    expect(conceptMeaning('earth.tides', 'earth.seasons.axial-tilt')).toBeUndefined();
  });
  it('accepts exact static ALL-OF locators and rejects wrong identity, meaning and duplicates', () => {
    expect(() => validateCoverageMapping(mapping(), target, catalogue)).not.toThrow();
    for (const changed of [
      { ...target, documentSha256: 'b'.repeat(64) },
      { ...target, provenanceSha256: 'b'.repeat(64) },
      { ...target, explanationUnitId: 'another-unit' },
      { ...target, framing: 'hypothetical' },
      { ...target, readingFactsVersion: 3 },
      { ...target, readingFactsSha256: 'b'.repeat(64) },
    ])
      expect(() => validateCoverageMapping(mapping(), changed, catalogue)).toThrow(
        'CONTENT_COVERAGE_IDENTITY_MISMATCH',
      );
    expect(() => validateCoverageMapping(mapping(), target, { ...catalogue, meaningSha256: () => undefined })).toThrow(
      'CONTENT_COVERAGE_BINDING_INVALID',
    );
    const duplicate = mapping();
    duplicate.bindings.push(duplicate.bindings[0]!);
    expect(() => validateCoverageMapping(duplicate, target, catalogue)).toThrow('CONTENT_COVERAGE_BINDING_INVALID');
    const repeat = mapping();
    repeat.bindings[0]!.requiredBlockIds.push('fixture-paragraph');
    expect(() => validateCoverageMapping(repeat, target, catalogue)).toThrow('CONTENT_COVERAGE_BINDING_INVALID');
  });
  test.prop([fc.constantFrom('subheading', 'disclosure', 'diagram', 'simulation', 'comparison', 'media', 'fallback')])(
    'never permits unsupported surface kinds, even when a locator exists',
    (type) => {
      expect(() =>
        validateCoverageMapping(
          mapping(),
          { ...target, blocks: [{ id: 'fixture-paragraph', type, nested: false, truthSupported: true }] },
          catalogue,
        ),
      ).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
    },
  );
  test.prop([fc.constantFrom('paragraph', 'quote', 'callout')])(
    'never promotes nested child visibility into a facet',
    (type) => {
      expect(() =>
        validateCoverageMapping(
          mapping(),
          { ...target, blocks: [{ id: 'fixture-paragraph', type, nested: true, truthSupported: true }] },
          catalogue,
        ),
      ).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
    },
  );
  it('bounds every list, admits only factual framing, and rejects schema extension/foreign locators', () => {
    expect(() =>
      validateCoverageMapping(
        mapping(),
        { ...target, blocks: [{ ...target.blocks[0]!, truthSupported: false }] },
        catalogue,
      ),
    ).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
    const map = mapping();
    expect(CoverageMappingSchema.safeParse({ ...map, framing: 'hypothetical' }).success).toBe(false);
    expect(CoverageMappingSchema.safeParse({ ...map, arbitrary: true }).success).toBe(false);
    expect(
      CoverageMappingSchema.safeParse({ ...map, bindings: Array.from({ length: 17 }, () => map.bindings[0]) }).success,
    ).toBe(false);
    expect(
      CoverageMappingSchema.safeParse({
        ...map,
        bindings: [{ ...map.bindings[0], requiredBlockIds: Array.from({ length: 9 }, (_, i) => String(i)) }],
      }).success,
    ).toBe(false);
    map.bindings[0]!.requiredBlockIds = ['foreign'];
    expect(() => validateCoverageMapping(map, target, catalogue)).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
    expect(CoverageCommandSchema.safeParse({ assetId: 'not-an-id' }).success).toBe(false);
  });
  describe('read-time view of a stored mapping', () => {
    it('ignores the catalogue digest, so a plan edit does not make coverage unreadable', () => {
      const grown = { sha256: 'c'.repeat(64), meaningSha256: () => hash };
      expect(() => validateCoverageMapping(mapping(), target, grown)).toThrow('CONTENT_COVERAGE_IDENTITY_MISMATCH');
      expect(currentCoverageMapping(mapping(), target, grown)).toEqual(mapping());
    });
    it('drops a binding whose facet vanished or changed meaning, and keeps the others', () => {
      const two = mapping();
      two.bindings.push({ ...two.bindings[0]!, facetId: 'earth.seasons.hemispheres' });
      const reworded = {
        meaningSha256: (_topic: string, facet: string) =>
          facet === 'earth.seasons.axial-tilt' ? 'd'.repeat(64) : hash,
      };
      expect(currentCoverageMapping(two, target, reworded).bindings.map((b) => b.facetId)).toEqual([
        'earth.seasons.hemispheres',
      ]);
      expect(currentCoverageMapping(two, target, { meaningSha256: () => undefined }).bindings).toEqual([]);
    });
    it('still refuses a mapping that does not fit the immutable document', () => {
      expect(() => currentCoverageMapping(mapping(), { ...target, documentSha256: 'b'.repeat(64) }, catalogue)).toThrow(
        'CONTENT_COVERAGE_IDENTITY_MISMATCH',
      );
      const foreign = mapping();
      foreign.bindings[0]!.requiredBlockIds = ['foreign'];
      expect(() => currentCoverageMapping(foreign, target, catalogue)).toThrow('CONTENT_COVERAGE_LOCATOR_INVALID');
      const duplicate = mapping();
      duplicate.bindings.push(duplicate.bindings[0]!);
      expect(() => currentCoverageMapping(duplicate, target, catalogue)).toThrow('CONTENT_COVERAGE_BINDING_INVALID');
    });
  });
});
