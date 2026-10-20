import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../infrastructure/receipts/index.js';
import { extractResearch } from '../../../infrastructure/research/public-pages.js';
import {
  hydrateSelectedClaims,
  quoteCandidates,
  verifyHydratedClaims,
  MAX_QUOTE_CANDIDATES,
} from './quote-candidates.js';

// Authored CI evidence only. No source fetch, provider call or generated product content.
const sentence =
  'This authored evidence sentence preserves original punctuation and enough distinctive source language to exercise immutable private quotation selection.';
const pageOf = (paragraphs: readonly string[], url = 'https://science.nasa.gov/earth/earth-facts/') =>
  extractResearch(
    `<html><title>Authored candidate fixture</title><main>${paragraphs.map((text) => `<p>${text}</p>`).join('')}</main></html>`,
    url,
    '2026-10-20T00:00:00.000Z',
  );
const paragraphs = Array.from({ length: 4 }, (_, n) => `${sentence} Fixture branch ${n}.`);

describe('quote candidates (authored CI fixture)', () => {
  it('hydrates exact original spans and reconstructs identical bytes after JSONB-style key reordering', () => {
    const page = pageOf(paragraphs);
    const pool = quoteCandidates([page]);
    const reordered = JSON.parse(
      canonicalJson({ ...page, passages: page.passages.map((p) => ({ ...p })) }),
    ) as typeof page;
    expect(quoteCandidates([reordered])).toEqual(pool);
    const selected = pool.map(({ id }) => id);
    const hydrated = hydrateSelectedClaims([reordered], pool, selected);
    expect(() => verifyHydratedClaims([reordered], pool, hydrated)).not.toThrow();
    for (const [n, candidate] of pool.entries()) {
      expect(candidate.text).toBe(page.passages[n]?.text.slice(candidate.start, candidate.end));
      expect(hydrated.claims[n]).toMatchObject({
        statement: candidate.text,
        quote: candidate.text,
        pageId: page.id,
        passageId: candidate.passageId,
        truthState: 'documented',
      });
      expect(hydrated.claims[n]?.claimId).toMatch(/^claim-[a-z0-9-]{1,48}$/u);
    }
    const changed = structuredClone(hydrated);
    if (changed.claims[0]) changed.claims[0] = { ...changed.claims[0], quote: `${changed.claims[0].quote} changed` };
    expect(() => verifyHydratedClaims([page], pool, changed)).toThrow('candidate_stored_claim_integrity');
  });
  it('partitions long paragraphs at complete sentences without dropping a short final caveat', () => {
    const long = `${Array.from({ length: 5 }, (_, n) => `${sentence} This is authored variation ${n}.`).join(' ')} Not always.`;
    expect(long.length).toBeGreaterThan(600);
    const page = pageOf([long, ...paragraphs.slice(0, 3)]);
    const original = page.passages[0];
    const spans = quoteCandidates([page]).filter(({ passageId }) => passageId === original?.id);
    expect(spans.length).toBeGreaterThan(1);
    expect(spans.map(({ text }) => text).join(' ')).toBe(long);
    expect(spans.at(-1)?.text).toContain('Not always.');
    for (const span of spans) {
      expect(span.text.length).toBeGreaterThanOrEqual(40);
      expect(span.text.length).toBeLessThanOrEqual(600);
      expect(original?.text.slice(span.start, span.end)).toBe(span.text);
      expect(span.text).toMatch(/[.!?]["'”’\])]*$/u);
    }
  });
  it('refuses an oversized sentence or unpunctuated tail instead of clipping the original', () => {
    const oversized = `${'Authored words without a sentence break '.repeat(20)}.`;
    expect(() => quoteCandidates([pageOf([oversized, ...paragraphs])])).toThrow('candidate_sentence_partition');
    const tail = `${sentence} ${'an unfinished source tail '.repeat(24)}`;
    expect(() => quoteCandidates([pageOf([tail, ...paragraphs])])).toThrow('candidate_sentence_boundary');
  });
  it('keeps multiple source identities, rejects foreign IDs and refuses forged offsets/hash/text/policy', () => {
    const first = pageOf(paragraphs);
    const second = pageOf(
      paragraphs.map((text) => `${text} A different source explicitly supplies separate context.`),
      'https://spaceplace.nasa.gov/seasons/en/',
    );
    const pool = quoteCandidates([first, second]);
    const selected = [pool[0]?.id ?? '', pool[1]?.id ?? '', pool[4]?.id ?? '', pool[5]?.id ?? ''];
    const hydrated = hydrateSelectedClaims([first, second], pool, selected);
    expect(new Set(hydrated.claims.map(({ pageId }) => pageId))).toEqual(new Set([first.id, second.id]));
    expect(() => hydrateSelectedClaims([first, second], pool, [selected[0] ?? '', ...selected.slice(0, 3)])).toThrow(
      'candidate_selection_duplicate',
    );
    expect(() => hydrateSelectedClaims([first], quoteCandidates([first]), selected)).toThrow('candidate_not_offered');
    for (const change of [
      { start: 1 },
      { end: 1 },
      { text: 'forged source quote' },
      { sha256: '0'.repeat(64) },
      { policyVersion: 'foreign' },
    ]) {
      const forged = pool.map((candidate, n) => (n === 0 ? { ...candidate, ...change } : candidate));
      expect(() => hydrateSelectedClaims([first, second], forged as typeof pool, selected)).toThrow(
        'candidate_pool_integrity',
      );
    }
  });
  it('refuses corrupt source identity, duplicate IDs, insufficient evidence and pool overflow', () => {
    const page = pageOf(paragraphs);
    const changed = {
      ...page,
      passages: page.passages.map((p, n) => (n === 0 ? { ...p, text: `${p.text} changed` } : p)),
    };
    expect(() => quoteCandidates([changed])).toThrow('candidate_research_integrity');
    expect(() => quoteCandidates([{ ...page, id: `page-${'0'.repeat(24)}` }])).toThrow('candidate_research_integrity');
    expect(() => quoteCandidates([page, page])).toThrow('candidate_identity_collision');
    const one = pageOf([`${sentence} ${sentence} ${sentence}`]);
    expect(() => quoteCandidates([one])).toThrow('candidate_pool_insufficient');
    const excess = pageOf(Array.from({ length: MAX_QUOTE_CANDIDATES + 1 }, (_, n) => `${sentence} Number ${n}.`));
    expect(() => quoteCandidates([excess])).toThrow('candidate_pool_too_large');
  });
});
