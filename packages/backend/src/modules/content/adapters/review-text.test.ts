import { describe, expect, it } from 'vitest';
import { validateDocumentV2 } from '@knowscroll/scroll-model';
import { evidencePassages } from '../production/evidence.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from '../production/spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from '../production/stored-v2.js';
import { publicationV2, type WriterV2Context } from '../production/writer-v2.js';
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

describe('the text an operator reads before releasing a v2 Scroll (labelled CI fixture)', () => {
  const document = orrin();
  const text = reviewTextOf(document);

  it('holds every word a reader can read, in reading order', () => {
    expect(text.startsWith(`${document.kicker} · ${document.title}`)).toBe(true);
    for (const stop of document.stops) {
      expect(text).toContain(`[${stop.id}]`);
      if (stop.kind === 'read') for (const block of stop.blocks) expect(text).toContain(block.text);
      else {
        expect(text).toContain(stop.prompt);
        for (const option of stop.options) expect(text).toContain(option);
        expect(text).toContain(stop.explain);
        expect(text).toContain(stop.twist);
      }
    }
    for (const aside of document.asides) expect(text).toContain(aside.text);
    for (const caption of document.recap.captions) expect(text).toContain(caption);
    const order = document.stops.map((stop) => text.indexOf(`[${stop.id}]`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('marks the correct option, the common guess with its source, and each picture', () => {
    expect(text).toContain('(correct');
    expect(text).toContain('common guess, source: CI fixture label');
    for (const state of document.stage?.states ?? []) expect(text).toContain(`PICTURE: ${state.alt}`);
    expect(text).toContain(
      'Misconception: Orrin is warmest because it is closest to its star. (source: CI fixture label, reviewed: true)',
    );
  });

  it('adds the passage each part cites, and the pages they come from, only when given', () => {
    expect(text).not.toContain('source passage:');
    const firstStop = document.stops[0]!.id;
    const withSources = reviewTextOf(document, {
      quotesByPart: new Map([[firstStop, ['An invented passage about Orrin.']]]),
      sources: ['CI fixture page (https://example.invalid/orrin)'],
    });
    expect(withSources).toContain('> source passage: An invented passage about Orrin.');
    expect(withSources).toContain('SOURCES\n  CI fixture page (https://example.invalid/orrin)');
  });
});
