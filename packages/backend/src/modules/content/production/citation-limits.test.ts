import { describe, expect, it } from 'vitest';
import { PROVENANCE_V2_LIMITS } from '@knowscroll/scroll-model/internal';
import { CITATIONS_TOO_MANY, citationLimitIssues } from './citation-limits.js';
import type { EvidencePassage } from './evidence.js';
import { evidencePassages } from './evidence.js';
import { fixtureResearchPageV2 } from './spike-v2/writer-v2.fixture.js';
import { publicationV2, writerRoleV2 } from './writer-v2.js';

/** `count` invented passages (the offered text is never read here), all from one page. */
const passagesOf = (count: number): EvidencePassage[] =>
  Array.from({ length: count }, (_, index) => ({
    handle: `e${String(index + 1)}`,
    claimId: `claim-ci-${String(index + 1)}`,
    pageId: 'page-ci-1',
    text: `Passage ${String(index + 1)} of a CI fixture page, about nothing real.`,
  }));
const citing = (claims: number) => ({ s1: passagesOf(claims).map((passage) => passage.claimId) });

describe('the bounds of what a v2 revision’s provenance can record', () => {
  it('lets a Scroll cite exactly as many different passages as the provenance holds, and no more', () => {
    const passages = passagesOf(PROVENANCE_V2_LIMITS.claims + 1);
    expect(citationLimitIssues(citing(PROVENANCE_V2_LIMITS.claims), passages)).toEqual([]);
    expect(citationLimitIssues(citing(PROVENANCE_V2_LIMITS.claims + 1), passages)).toEqual([
      { code: CITATIONS_TOO_MANY, path: 'items' },
    ]);
  });

  it('counts different passages, not citations: reusing one passage everywhere is fine', () => {
    const one = passagesOf(1);
    const parts = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`s${String(index + 1)}`, ['claim-ci-1']]),
    );
    expect(citationLimitIssues(parts, one)).toEqual([]);
  });

  it('gives the one repair a fixed hint for it, so the finding is not silent', () => {
    const role = writerRoleV2({
      publication: publicationV2('seasons'),
      recipe: { variant: 'plain', misconception: { kind: 'none' } },
      passages: evidencePassages([fixtureResearchPageV2]),
      pages: [fixtureResearchPageV2],
    });
    expect(role.safeCustomIssues?.[CITATIONS_TOO_MANY]).toContain(String(PROVENANCE_V2_LIMITS.claims));
  });
});
