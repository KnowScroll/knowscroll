import { describe, expect, it } from 'vitest';
import { beatsOfV3, parseDocumentV3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import broadStreet from '../fixtures/document-v3/broad-street.editorial-scroll-v3.json' with { type: 'json' };
import seasons from '../fixtures/document-v3/seasons.editorial-scroll-v3.json' with { type: 'json' };
import { listingFactsOfV3 } from './review-gate.js';
import { compileEditorialSourceV3 } from './scroll-compiler-v3.js';

function documentV3(source: unknown): ScrollDocumentV3 {
  const compiled = compileEditorialSourceV3(source, 1);
  if (compiled.kind !== 'compiled') throw new Error('CI expected the fixture to compile');
  const parsed = parseDocumentV3(compiled.document);
  if (parsed.kind !== 'valid') throw new Error('CI expected a valid document v3');
  return parsed.document;
}

describe('what the review list says about a held document v3 (labelled CI fixtures)', () => {
  it('counts its beats, its pictures by kind and its controls, and always has a picture', () => {
    for (const source of [seasons, broadStreet]) {
      const document = documentV3(source);
      const facts = listingFactsOfV3(document);
      expect(facts.stops).toBe(beatsOfV3(document).length);
      expect(facts.v3?.beats).toBe(facts.stops);
      expect(facts.calls).toBe(0);
      expect(facts.hasPicture).toBe(true);
      expect(facts.readingMinutes).toBe(document.measures.readingMinutes);
      expect(facts.words).toBe(document.measures.mainWords);
      const byKind = facts.v3?.pictures ?? {};
      expect(Object.values(byKind).reduce((total, count) => total + count, 0)).toBe(document.pictures.length);
      for (const picture of document.pictures) expect(byKind[picture.kind]).toBeGreaterThan(0);
    }
  });

  it('counts the controls of the beats that carry one', () => {
    const document = documentV3(broadStreet);
    const expected = beatsOfV3(document).filter((beat) => beat.kind === 'plain' && beat.control !== undefined).length;
    expect(listingFactsOfV3(document).v3?.controls).toBe(expected);
  });
});
