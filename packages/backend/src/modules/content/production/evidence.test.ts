import { describe, expect, it } from 'vitest';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import {
  authoringEvidence,
  EvidenceRefusal,
  evidencePassages,
  evidenceText,
  MAX_EVIDENCE_PASSAGES,
} from './evidence.js';

// Authored CI evidence only. No source fetch, provider call or generated product content.
const sentence = (n: number) =>
  `This authored fixture sentence number ${n} describes a harmless invented harbour detail for a test.`;
const pageOf = (paragraphs: readonly string[]) =>
  extractResearch(
    `<html><title>Authored fixture</title><main>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</main></html>`,
    'https://science.nasa.gov/earth/earth-facts/',
    '2026-10-20T00:00:00.000Z',
  );
const paragraphs = Array.from({ length: 5 }, (_, n) => `${sentence(n)} It continues a little further here.`);

describe('evidence passages', () => {
  it('offers the research text as numbered passages in page order, each an exact source substring', () => {
    const page = pageOf(paragraphs);
    const passages = evidencePassages([page]);
    expect(passages.map((passage) => passage.handle)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    passages.forEach((passage, index) => {
      expect(page.passages[index]?.text).toContain(passage.text);
      expect(passage.pageId).toBe(page.id);
      expect(passage.claimId).toMatch(/^claim-[0-9a-f]{40}$/u);
    });
    expect(new Set(passages.map((passage) => passage.claimId)).size).toBe(5);
    // The same pages always give the same handles and claim IDs, so a resumed job sees what the first attempt saw.
    expect(evidencePassages([structuredClone(page)])).toEqual(passages);
  });

  it('reads as one line per passage and maps handles back to claim IDs and source text', () => {
    const passages = evidencePassages([pageOf(paragraphs)]);
    expect(evidenceText(passages).split('\n')[2]).toBe(`[e3] ${passages[2]?.text}`);
    const evidence = authoringEvidence(passages);
    expect(evidence.claimIdOf.get('e4')).toBe(passages[3]?.claimId);
    expect(evidence.quoteOf.get(passages[3]?.claimId ?? '')).toBe(passages[3]?.text);
    expect(evidence.minDistinctCitations).toBe(4);
  });

  it('splits a long paragraph only at sentence ends, keeping every word and a short closing caveat', () => {
    const long = `${Array.from({ length: 9 }, (_, n) => sentence(n)).join(' ')} Not always.`;
    expect(long.length).toBeGreaterThan(600);
    const page = pageOf([long, ...paragraphs.slice(0, 3)]);
    const parts = evidencePassages([page]).filter((passage) => long.includes(passage.text));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.text).join(' ')).toBe(long);
    expect(parts.at(-1)?.text).toContain('Not always.');
    for (const part of parts) {
      expect(part.text.length).toBeGreaterThanOrEqual(40);
      expect(part.text.length).toBeLessThanOrEqual(600);
    }
  });

  it('leaves out a paragraph it cannot split at sentence ends instead of clipping it or refusing the page', () => {
    const unsplittable = `${'a long run of words without any full stop at all '.repeat(15)}`;
    expect(unsplittable.length).toBeGreaterThan(600);
    const passages = evidencePassages([pageOf([unsplittable, ...paragraphs])]);
    expect(passages).toHaveLength(5);
    expect(passages.every((passage) => !unsplittable.includes(passage.text))).toBe(true);
  });

  it('refuses a source with fewer than four passages and offers at most sixty-four', () => {
    const sparse = pageOf([
      `${sentence(0)} ${sentence(1)} ${sentence(2)}`,
      `${sentence(3)} ${sentence(4)} ${sentence(5)}`,
    ]);
    expect(() => evidencePassages([sparse])).toThrow(EvidenceRefusal);
    const many = Array.from({ length: 70 }, (_, n) => `${sentence(n)} Paragraph ${n} of a long page.`);
    const pages = [pageOf(many.slice(0, 35)), pageOf(many.slice(35))];
    const passages = evidencePassages(pages);
    expect(passages).toHaveLength(MAX_EVIDENCE_PASSAGES);
    expect(passages.at(-1)?.handle).toBe(`e${MAX_EVIDENCE_PASSAGES}`);
  });
});
