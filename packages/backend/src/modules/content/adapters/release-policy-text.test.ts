import { describe, expect, it } from 'vitest';
import { validateDocumentV2 } from '@knowscroll/scroll-model';
import { categoriesOfText } from '../domain/release-policy.js';
import { evidencePassages } from '../production/evidence.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from '../production/spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from '../production/stored-v2.js';
import { publicationV2, type WriterV2Context } from '../production/writer-v2.js';
import { scanTextOf } from './release-policy.js';
import { reviewTextOf } from './review-text.js';

const context: WriterV2Context = {
  publication: publicationV2('seasons'),
  recipe: {
    variant: 'stage',
    misconception: {
      kind: 'myth',
      claim: 'Orrin is warmest because it is closest to its star.',
      source: { label: 'CI fixture label', reviewed: true },
    },
  },
  passages: evidencePassages([fixtureResearchPageV2]),
  pages: [fixtureResearchPageV2],
};

/** The labelled Orrin fixture (invented, never product content), compiled the way production stores it. */
function orrin() {
  const outcome = storedScrollV2(fixtureAuthoredV2(), context, {
    runId: 'run-ci-1',
    attemptIds: ['attempt-ci-1'],
    model: 'MiniMax-M3.1-Flash',
  });
  if (outcome.kind !== 'compiled') throw new Error('CI expected a compile');
  const checked = validateDocumentV2(outcome.document);
  if (checked.kind !== 'valid') throw new Error('CI expected a valid document');
  return checked.document;
}

describe('the text the release policy scans for sensitive words (labelled CI fixture)', () => {
  const document = orrin();

  it('is what an operator reads of the Scroll, without the line of measures or the answer check’s note', () => {
    const read = reviewTextOf(document);
    const scanned = scanTextOf(document);
    expect(read).toMatch(/^\d+ words · /mu);
    expect(read).toContain('Answer check: ');
    expect(scanned).not.toMatch(/^\d+ words · /mu);
    expect(scanned).not.toContain('Answer check: ');
    expect(scanned).toContain(document.title);
    for (const caption of document.recap.captions) expect(scanned).toContain(caption);
    for (const suggestion of document.askSuggestions) expect(scanned).toContain(suggestion);
  });

  it('matches nothing in the ordinary Scroll, so a clean Scroll is not held for its words', () => {
    expect(categoriesOfText(scanTextOf(document))).toEqual([]);
  });

  it('leaves out the line of measures because a count of words can read as a year: 2,050 words would make a Scroll look recent', () => {
    const header = reviewTextOf(document).replace(/^\d+ words · /mu, '2050 words · ');
    expect(categoriesOfText(header)).toEqual(['current_events']);
    expect(categoriesOfText(scanTextOf(document))).toEqual([]);
  });
});
