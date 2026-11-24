import { describe, expect, it } from 'vitest';
import { PROVENANCE_V3_LIMITS } from '@knowscroll/scroll-model/internal';
import { CITATIONS_TOO_MANY, CITATIONS_TOO_MANY_HINT_V3, citationLimitIssuesV3 } from './citation-limits.js';
import type { EvidencePassage } from './evidence.js';

/** `count` invented passages (the offered text is never read here), all from one page. */
const passagesOf = (count: number): EvidencePassage[] =>
  Array.from({ length: count }, (_, index) => ({
    handle: `e${String(index + 1)}`,
    claimId: `claim-ci-${String(index + 1)}`,
    pageId: 'page-ci-1',
    text: `Passage ${String(index + 1)} of a CI fixture page, about nothing real.`,
  }));
const citing = (claims: number) => ({ s1: passagesOf(claims).map((passage) => passage.claimId) });

describe('the bounds of what a document v3 revision’s provenance can record', () => {
  it('has the limits the writer is told: 48 claims, 24 sources and 22 parts', () => {
    expect(PROVENANCE_V3_LIMITS).toEqual({ claims: 48, sources: 24, citations: 22 });
  });

  it('lets a Scroll cite exactly as many different passages as the provenance holds, and no more', () => {
    const passages = passagesOf(PROVENANCE_V3_LIMITS.claims + 1);
    expect(citationLimitIssuesV3(citing(PROVENANCE_V3_LIMITS.claims), passages)).toEqual([]);
    expect(citationLimitIssuesV3(citing(PROVENANCE_V3_LIMITS.claims + 1), passages)).toEqual([
      { code: CITATIONS_TOO_MANY, path: 'items' },
    ]);
  });

  it('puts the finding where the repair can change it: the pictures, for a staging reply over fixed prose', () => {
    const passages = passagesOf(PROVENANCE_V3_LIMITS.claims + 1);
    expect(citationLimitIssuesV3(citing(PROVENANCE_V3_LIMITS.claims + 1), passages, 'pictures')).toEqual([
      { code: CITATIONS_TOO_MANY, path: 'pictures' },
    ]);
  });

  it('counts the parts that cite, too: a beat, an aside, a picture and the takeaway each have an entry', () => {
    const passages = passagesOf(1);
    const parts = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`part${String(index + 1)}`, ['claim-ci-1']]));
    expect(citationLimitIssuesV3(parts(PROVENANCE_V3_LIMITS.citations), passages)).toEqual([]);
    expect(citationLimitIssuesV3(parts(PROVENANCE_V3_LIMITS.citations + 1), passages)).toHaveLength(1);
  });

  it('counts different passages, not citations: reusing one passage everywhere is fine', () => {
    expect(citationLimitIssuesV3({ b1: ['claim-ci-1'], b2: ['claim-ci-1'] }, passagesOf(1))).toEqual([]);
  });

  it('bounds the parts that cite at 22', () => {
    const one = passagesOf(1);
    const parts = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`b${String(index + 1)}`, ['claim-ci-1']]));
    expect(citationLimitIssuesV3(parts(PROVENANCE_V3_LIMITS.citations), one)).toEqual([]);
    expect(citationLimitIssuesV3(parts(PROVENANCE_V3_LIMITS.citations + 1), one)).toEqual([
      { code: CITATIONS_TOO_MANY, path: 'items' },
    ]);
  });

  it('bounds the pages the cited passages come from at 24', () => {
    const passages = Array.from({ length: PROVENANCE_V3_LIMITS.sources + 1 }, (_, index) => ({
      handle: `e${String(index + 1)}`,
      claimId: `claim-ci-${String(index + 1)}`,
      pageId: `page-ci-${String(index + 1)}`,
      text: `Passage ${String(index + 1)} of a CI fixture page, about nothing real.`,
    }));
    const citingPages = (count: number) => ({ b1: passages.slice(0, count).map((passage) => passage.claimId) });
    expect(citationLimitIssuesV3(citingPages(PROVENANCE_V3_LIMITS.sources), passages)).toEqual([]);
    expect(citationLimitIssuesV3(citingPages(PROVENANCE_V3_LIMITS.sources + 1), passages)).toEqual([
      { code: CITATIONS_TOO_MANY, path: 'items' },
    ]);
  });

  it('gives the repair a v3 hint that names the v3 limits', () => {
    expect(CITATIONS_TOO_MANY_HINT_V3).toContain(String(PROVENANCE_V3_LIMITS.claims));
    expect(CITATIONS_TOO_MANY_HINT_V3).toContain(String(PROVENANCE_V3_LIMITS.citations));
    // The harness accepts a hint of 1 to 256 characters (`validSafeCustomIssues`).
    expect(CITATIONS_TOO_MANY_HINT_V3.length).toBeLessThanOrEqual(256);
  });
});
