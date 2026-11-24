import { describe, expect, it } from 'vitest';
import { validateDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import { ReadingFactsSchema } from '../adapters/reading-facts-schema.js';
import { fixtureResearchPageV2, storedOrrinV2 } from './orrin.fixture.js';
import { WRITER_V2_PROMPT_VERSION } from './writer-v2-version.js';

const whose = { assetId: 'af2628f1-98a7-4c39-9f81-628506d247a1', explanationUnitId: 'ci-orrin-unit' } as const;

describe('the stored v2 Orrin fixture (a labelled CI fixture, never product content)', () => {
  it.each(['stage', 'plain'] as const)('is a valid stored v2 revision, for whose it is, with %s', (variant) => {
    const stored = storedOrrinV2({ ...whose, revision: 3, variant });
    const checked = validateDocumentV2(stored.document);
    if (checked.kind !== 'valid') throw new Error(JSON.stringify(checked.issues));
    expect(checked.document).toMatchObject({
      assetId: whose.assetId,
      revision: 3,
      explanationUnitId: whose.explanationUnitId,
    });
    expect(checked.document.integrity.sha256).toBe(stored.documentSha256);
    expect(checked.document.stage !== undefined).toBe(variant === 'stage');
    expect(ReadingFactsSchema.safeParse(stored.readingFacts).success).toBe(true);
  });

  it('has provenance that names the same document, cites only claims it holds and says the v2 writer wrote it', () => {
    const stored = storedOrrinV2({ ...whose, revision: 2 });
    const provenance = ScrollProvenanceV2.parse(stored.provenance);
    expect(provenance).toMatchObject({ assetId: whose.assetId, revision: 2, documentSha256: stored.documentSha256 });
    expect(provenance.production).toMatchObject({ kind: 'model', promptVersion: WRITER_V2_PROMPT_VERSION });
    const claimIds = new Set(provenance.claims.map((claim) => claim.claimId));
    for (const entry of provenance.citations) for (const id of entry.claimIds) expect(claimIds.has(id)).toBe(true);
    for (const claim of provenance.claims)
      expect(fixtureResearchPageV2.passages.some((passage) => passage.text === claim.quote)).toBe(true);
  });

  it('is sealed again after an edit: its measures and hash follow the words, so the document stays valid', () => {
    const plain = storedOrrinV2({ ...whose });
    const edited = storedOrrinV2({
      ...whose,
      edit: (document: ScrollDocumentV2) => {
        document.title = `${document.title} again`;
      },
    });
    expect(edited.documentSha256).not.toBe(plain.documentSha256);
    expect(validateDocumentV2(edited.document).kind).toBe('valid');
    expect(edited.provenance['documentSha256']).toBe(edited.documentSha256);
  });
});
