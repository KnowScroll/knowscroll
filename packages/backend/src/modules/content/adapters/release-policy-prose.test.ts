import { describe, expect, it } from 'vitest';
import { validateDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { categoriesOfText, proseOf } from '../domain/release-policy.js';
import { evidencePassages } from '../production/evidence.js';
import { fixtureAuthoredV2, fixtureResearchPageV2 } from '../production/spike-v2/writer-v2.fixture.js';
import { storedScrollV2 } from '../production/stored-v2.js';
import { publicationV2, type WriterV2Context } from '../production/writer-v2.js';

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
function orrin(): ScrollDocumentV2 {
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

/** A clone of the document with `text` put at `path` of its own fields. */
function planted(document: ScrollDocumentV2, path: readonly (string | number)[], text: string): ScrollDocumentV2 {
  const clone = JSON.parse(JSON.stringify(document)) as unknown;
  let node = clone as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path.at(-1)!] = text;
  return clone as ScrollDocumentV2;
}

describe('the words the release policy scans (labelled CI fixture)', () => {
  const document = orrin();

  it('are every field of the document that a reader reads, taken from the fields themselves', () => {
    const prose = proseOf(document);
    expect(prose).toContain(document.kicker);
    expect(prose).toContain(document.title);
    expect(prose).toContain(document.dek);
    if (document.misconception.kind === 'myth') expect(prose).toContain(document.misconception.claim);
    for (const state of document.stage?.states ?? []) expect(prose).toContain(state.alt);
    for (const stop of document.stops) {
      if (stop.kind === 'read') {
        for (const block of stop.blocks) expect(prose).toContain(block.text);
        expect(prose).toContain(stop.simple);
      } else {
        for (const text of [stop.prompt, ...stop.options, stop.explain, stop.twist, stop.simple])
          expect(prose).toContain(text);
      }
    }
    for (const aside of document.asides) for (const text of [aside.title, aside.text]) expect(prose).toContain(text);
    for (const caption of document.recap.captions) expect(prose).toContain(caption);
    for (const suggestion of document.askSuggestions) expect(prose).toContain(suggestion);
  });

  it('leave out identity, versions, measures and the integrity hash, which are not words', () => {
    const prose = proseOf(document);
    for (const technical of [
      document.assetId,
      document.schemaVersion,
      document.explanationUnitId,
      document.integrity.sha256,
      document.limitsVersion,
    ])
      expect(prose).not.toContain(technical);
    // A group of four digits in an identifier would read as a year if it were scanned.
    const withYearLikeId = planted(document, ['assetId'], '00000000-2024-4000-8000-000000000000');
    expect(proseOf(withYearLikeId)).not.toContain('2024');
    expect(categoriesOfText(proseOf(withYearLikeId))).toEqual([]);
  });

  it('match nothing in the ordinary Scroll, so a clean Scroll is not held for its words', () => {
    expect(categoriesOfText(proseOf(document))).toEqual([]);
  });

  it.each([
    ['the kicker', ['kicker'], 'The legal side'],
    ['the title', ['title'], 'Dosage and the seasons'],
    ['the dek', ['dek'], 'A look at the election of a season.'],
    ['the misconception', ['misconception', 'claim'], 'Poison makes winter.'],
    ['the picture’s description', ['stage', 'states', 0, 'alt'], 'A weapon drawn.'],
    ['a line of a read stop', ['stops', 0, 'blocks', 1, 'text'], 'Ask your lawyer.'],
    ['the simpler words of a stop', ['stops', 0, 'simple'], 'Take a vaccine.'],
    ['a question of a call', ['stops', 1, 'prompt'], 'Is it a crime in 2030?'],
    ['an option of a call', ['stops', 1, 'options', 0], 'Invest in stocks'],
    ['the explanation of a call', ['stops', 1, 'explain'], 'The court said so.'],
    ['the twist of a call', ['stops', 1, 'twist'], 'A pandemic changed it.'],
    ['an aside', ['asides', 0, 'text'], 'Is it safe to try? Mind the hazard.'],
    ['the recap', ['recap', 'captions', 0], 'Say a prayer for the best.'],
    ['an Ask suggestion', ['askSuggestions', 2], 'Is a divorce legal?'],
  ] as const)('find a sensitive word in %s', (_name, path, text) => {
    expect(categoriesOfText(proseOf(planted(document, path, text))).length).toBeGreaterThan(0);
  });

  it('are never filtered out by how they begin: a line that starts like a note of the review text is still read', () => {
    const tricky = planted(document, ['stops', 0, 'blocks', 1, 'text'], 'Answer check: is it legal to sell this?');
    expect(categoriesOfText(proseOf(tricky))).toEqual(['law']);
  });
});
