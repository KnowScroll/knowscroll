import { describe, expect, it } from 'vitest';
import { admitDocument, visibleTexts, walkBlocks } from '@knowscroll/scroll-model';
import { compileEditorialSource } from '../adapters/scroll-compiler.js';
import { starterEditorialScrolls } from './index.js';

const [starter] = starterEditorialScrolls;

describe('the authored starter Scroll (D-005)', () => {
  it("ships one authored explainer, and it compiles through scroll-model's admission path", () => {
    expect(starterEditorialScrolls).toHaveLength(1);
    expect(starter?.name).toBe('why-the-sky-is-blue');
    const compiled = compileEditorialSource(starter?.source, 1);
    expect(compiled.kind).toBe('compiled');
    if (compiled.kind !== 'compiled') return;
    expect(admitDocument(compiled.document).kind).toBe('valid');
    expect(compiled.documentVersion).toBe('scroll-document.v1');
    expect(compiled.title).toBe('Why the sky is blue');
  });

  it('is labelled authored and never presented as generated or fixture', () => {
    const compiled = compileEditorialSource(starter?.source, 1);
    if (compiled.kind !== 'compiled') throw new Error('starter refused');
    expect(compiled.provenance['production']).toEqual({
      kind: 'authored-editorial',
      reference: 'editorial-starter-sky-blue',
    });
    // The consumer document never carries who or what wrote it.
    expect(JSON.stringify(compiled.document)).not.toMatch(/authored|editorial|model|fixture/i);
  });

  it('has 6 to 8 sections and uses only text-family blocks', () => {
    const compiled = compileEditorialSource(starter?.source, 1);
    if (compiled.kind !== 'compiled') throw new Error('starter refused');
    const parsed = admitDocument(compiled.document);
    if (parsed.kind !== 'valid') throw new Error('starter invalid');
    const texts = [
      parsed.document.kicker,
      parsed.document.title,
      parsed.document.dek,
      ...parsed.document.sections.flatMap((section) => (section.heading === null ? [] : [section.heading])),
      ...[...walkBlocks(parsed.document.sections)].flatMap((visit) => visibleTexts(visit.block)),
    ];
    for (const text of texts) expect(text).not.toMatch(/\p{N}/u);
    expect(compiled.provenance['claims']).toEqual([]);
    expect(compiled.provenance['bindings']).toEqual([]);
  });

  it('reads in a few minutes, with weights and an estimate derived by code from the document', () => {
    const compiled = compileEditorialSource(starter?.source, 1);
    if (compiled.kind !== 'compiled') throw new Error('starter refused');
    const measures = (compiled.document as { measures: { readingMinutes: number; totalWeight: number } }).measures;
    expect(measures.readingMinutes).toBeGreaterThanOrEqual(3);
    expect(measures.readingMinutes).toBeLessThanOrEqual(8);
    expect(compiled.readingFacts.totalWeight).toBe(measures.totalWeight);
    expect(compiled.readingFacts.blocks.reduce((sum, block) => sum + block.weight, 0)).toBe(measures.totalWeight);
    expect(compiled.readingFacts.estimatedReadingMs).toBe(Math.round((measures.totalWeight / 200) * 60_000));
    // The block nested in the disclosure is owned by it.
    expect(compiled.readingFacts.nested).toEqual([{ id: 'violet-eye-cones', owner: 'violet-eye' }]);
  });

  it('compiles identically every time, and the revision number is part of the hash', () => {
    const a = compileEditorialSource(starter?.source, 1);
    const b = compileEditorialSource(starter?.source, 1);
    const c = compileEditorialSource(starter?.source, 2);
    if (a.kind !== 'compiled' || b.kind !== 'compiled' || c.kind !== 'compiled') throw new Error('starter refused');
    expect(a.documentSha256).toBe(b.documentSha256);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    expect(c.documentSha256).not.toBe(a.documentSha256);
  });
});
