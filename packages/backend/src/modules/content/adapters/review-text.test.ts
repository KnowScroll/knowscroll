import { RECIPES } from '../domain/library/index.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beatsOfV3,
  describePicture,
  parseDocumentV3,
  scrubPositions,
  validateDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import broadStreet from '../fixtures/document-v3/broad-street.editorial-scroll-v3.json' with { type: 'json' };
import fence from '../fixtures/document-v3/fence.editorial-scroll-v3.json' with { type: 'json' };
import seasons from '../fixtures/document-v3/seasons.editorial-scroll-v3.json' with { type: 'json' };
import { compileEditorialSourceV3 } from './scroll-compiler-v3.js';
import { storedOrrinV2 } from '../production/orrin.fixture.js';
import { answerCheckLines, reviewTextOf, reviewTextV3 } from './review-text.js';

/** The labelled Orrin fixture (invented, never product content), as the v2 writer stored it. */
function orrin() {
  const outcome = storedOrrinV2({
    assetId: RECIPES.seasons.assetId,
    explanationUnitId: RECIPES.seasons.explanationUnitId,
  });
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

  it('names the picture a wrong pick turns the stage to, from the stop the call points at (D-383)', () => {
    const call = document.stops.find((stop) => stop.kind === 'call_it');
    if (call?.kind !== 'call_it' || call.revealStage === undefined)
      throw new Error('CI expected a reveal on the first call');
    const turnedTo = document.stage?.states.find((entry) => entry.stop === call.revealStage);
    expect(turnedTo).toBeDefined();
    expect(text).toContain(`After a wrong pick the picture turns to: ${turnedTo?.alt ?? ''}`);
    // A call that turns nothing says nothing of it.
    const others = text.split('\n').filter((line) => line.includes('the picture turns to'));
    expect(others).toHaveLength(1);
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

describe('what an operator is told about the answer check before reading the calls (D-198)', () => {
  const document = orrin();
  const flag = { id: 'c2', consistent: false, problem: 'The key marks B but the explanation says A is right.' };

  it('says a revision made before the check was not checked, and never leaves the line out', () => {
    const text = reviewTextOf(document);
    expect(text).toContain('Answer check: not run for this revision');
    expect(answerCheckLines(null)).toHaveLength(1);
  });

  it('puts the check right under the header, before the first stop', () => {
    const text = reviewTextOf(document, undefined, { outcome: 'passed', calls: 3 });
    expect(text).toContain('Answer check: passed. The checker found all 3 calls consistent');
    expect(text.indexOf('Answer check:')).toBeLessThan(text.indexOf(`[${document.stops[0]!.id}]`));
  });

  it('shows what the first draft was flagged for when the writer repaired it', () => {
    const lines = answerCheckLines({ outcome: 'repaired', calls: 3, firstDraftFlags: [flag] });
    expect(lines[0]).toContain('repaired');
    expect(lines).toContain('    [c2] The key marks B but the explanation says A is right.');
  });

  it('says plainly that nothing was checked, with the reason, and asks for every call to be read', () => {
    const [line] = answerCheckLines({ outcome: 'unchecked', code: 'outcome_unknown', firstDraftFlags: [] });
    expect(line).toContain('NOT CHECKED (outcome_unknown)');
    expect(line).toContain('Read every call');
  });

  it('prints the flagged call as the checker saw it: the question, the options with the marked one, and the explanation', () => {
    const call = {
      prompt: 'Why is the north warm in midsummer?',
      options: ['Its half leans toward the star', 'It is closest to the star'],
      answer: 1,
      explain: 'The lean is the cause, not the distance.',
    };
    const lines = answerCheckLines({
      outcome: 'repaired',
      calls: 3,
      firstDraftFlags: [{ ...flag, call }],
    });
    expect(lines).toContain('      Question: Why is the north warm in midsummer?');
    expect(lines).toContain('        A. Its half leans toward the star');
    expect(lines).toContain('        B. It is closest to the star (marked correct)');
    expect(lines).toContain('      Explanation: The lean is the cause, not the distance.');
  });

  it('lists the flags that stood', () => {
    const lines = answerCheckLines({ outcome: 'flagged', flags: [flag], firstDraftFlags: [] });
    expect(lines[0]).toContain('FLAGGED');
    expect(lines[1]).toContain('[c2]');
  });
});

describe('the play blocks and the guide in the text an operator reads (labelled CI fixtures)', () => {
  const read = (name: string): string => {
    const raw = JSON.parse(
      readFileSync(new URL(`../../../../../scroll-model/fixtures/documents/${name}-ci.json`, import.meta.url), 'utf8'),
    ) as unknown;
    const checked = validateDocumentV2(raw, { verify: false });
    if (checked.kind !== 'valid') throw new Error('CI expected a valid fixture');
    return reviewTextOf(checked.document);
  };

  it('shows the answer key of a sort, both paths of a fork and the guide line', () => {
    const text = read('sort-fork-blocks');
    expect(text).toContain('SORT, correct order: 1. The lean points toward Vael 2. Sunlight arrives steeply');
    expect(text).toContain('SORT, why:');
    expect(text).toContain('FORK: Which half do you want to follow? The north:');
    expect(text).toContain('The south: The south cools');
    expect(text).toContain('GUIDE (ray, wonder): Same sunshine, more ground');
  });

  it('shows every figure of a scale and of a chart, so each can be checked against its source', () => {
    const text = read('scale-chart-blocks');
    expect(text).toContain('SCALE: A logarithmic scale in million km');
    expect(text).toContain('Sarn: 1,200 million km');
    expect(text).toContain('CHART: A bar chart in trips');
    expect(text).toContain('1,000 crates: 1,000,000 trips');
  });
});

/** A hand-written document v3 fixture (labelled, never product content), compiled and parsed as the review gate reads it. */
function documentV3(source: unknown): ScrollDocumentV3 {
  const compiled = compileEditorialSourceV3(source, 1);
  if (compiled.kind !== 'compiled') throw new Error('CI expected the fixture to compile');
  const parsed = parseDocumentV3(compiled.document);
  if (parsed.kind !== 'valid') throw new Error('CI expected a valid document v3');
  return parsed.document;
}

describe('the text an operator reads before releasing a document v3 Scroll (labelled CI fixtures)', () => {
  it.each([
    ['seasons', seasons],
    ['fence', fence],
    ['broad-street', broadStreet],
  ])('holds every word a reader can read in %s, in reading order, with each picture in its words', (_name, source) => {
    const document = documentV3(source);
    const text = reviewTextV3(document);
    expect(text.startsWith(`${document.kicker} · ${document.title}\n${document.dek}\n`)).toBe(true);
    expect(text).toContain(`${document.measures.readingMinutes} minutes`);
    let from = 0;
    for (const section of document.sections) {
      const at = text.indexOf(`SECTION [${section.id}] ${section.title}`, from);
      expect(at, section.title).toBeGreaterThanOrEqual(from);
      from = at;
      for (const beat of section.beats) {
        const place = text.indexOf(`[${beat.id}]`, from);
        expect(place, beat.id).toBeGreaterThanOrEqual(from);
        from = place;
        expect(text).toContain(beat.text);
        expect(text).toContain(`Simpler: ${beat.simple}`);
        if (beat.show !== undefined) {
          const picture = document.pictures.find((candidate) => candidate.id === beat.show?.picture);
          if (picture === undefined) throw new Error('CI expected a declared picture');
          expect(text).toContain(`PICTURE [${picture.id}]: ${describePicture(picture, beat.show.state)}`);
        }
      }
    }
    for (const aside of document.asides) expect(text).toContain(`ASIDE (${aside.kind}`);
    expect(text).toContain(`TO SUM UP\n  ${document.takeaway}`);
    for (const suggestion of document.askSuggestions) expect(text).toContain(`  ${suggestion}`);
    for (const picture of document.pictures)
      expect(text).toContain(`[${picture.id}] ${picture.kind}: ${picture.title}`);
  });

  it('names each linked phrase and the part it names, and who said a quotation', () => {
    const documents = [seasons, fence, broadStreet].map(documentV3);
    const beats = documents.flatMap((document) => beatsOfV3(document));
    expect(beats.some((beat) => beat.links.length > 0)).toBe(true);
    expect(beats.some((beat) => beat.kind === 'quote')).toBe(true);
    for (const document of documents) {
      const text = reviewTextV3(document);
      for (const beat of beatsOfV3(document)) {
        for (const link of beat.links) expect(text).toContain(`LINK "${link.phrase}" -> ${link.part}`);
        if (beat.kind === 'quote') {
          expect(text).toContain(`[${beat.id}] (quotation)`);
          expect(text).toContain(`QUOTE FROM: ${beat.cite.who}`);
        }
      }
    }
  });

  it('shows a control and the words of every state it reaches', () => {
    const documents = [seasons, fence, broadStreet].map(documentV3);
    const controlled = documents.flatMap((document) =>
      beatsOfV3(document).flatMap((beat) =>
        beat.kind === 'plain' && beat.control !== undefined && beat.show !== undefined
          ? [{ document, beat, control: beat.control, show: beat.show }]
          : [],
      ),
    );
    expect(controlled.length).toBeGreaterThan(0);
    for (const { document, beat, control, show } of controlled) {
      const text = reviewTextV3(document);
      expect(text).toContain(`CONTROL (${control.kind}) "${control.label}"`);
      const picture = document.pictures.find((candidate) => candidate.id === show.picture);
      if (picture === undefined) throw new Error('CI expected a declared picture');
      if (control.kind === 'scrub')
        for (const position of scrubPositions(picture, show.state, control.along))
          expect(text, beat.id).toContain(`${position.label}: ${describePicture(picture, position.state)}`);
      if (control.kind === 'switch') expect(text).toContain(`Switches to: ${describePicture(picture, control.to)}`);
    }
  });

  it('puts the passages each part cites after it, including a picture and the takeaway, and lists the sources', () => {
    const document = documentV3(seasons);
    const first = beatsOfV3(document)[0];
    const picture = document.pictures[0];
    if (first === undefined || picture === undefined) throw new Error('CI expected a beat and a picture');
    const text = reviewTextV3(document, {
      quotesByPart: new Map([
        [first.id, ['A quoted passage for the first beat.']],
        [picture.id, ['A quoted passage for the picture.']],
        ['takeaway', ['A quoted passage for the takeaway.']],
      ]),
      sources: ['A CI page (https://example.test/page)'],
    });
    expect(text).toContain('  > source passage: A quoted passage for the first beat.');
    expect(text).toContain('  > source passage: A quoted passage for the picture.');
    expect(text).toContain(`TO SUM UP\n  ${document.takeaway}\n  > source passage: A quoted passage for the takeaway.`);
    expect(text).toContain('SOURCES\n  A CI page (https://example.test/page)');
    expect(reviewTextV3(document)).not.toContain('source passage');
  });

  it('leaves the support check line out unless asked, and says it has not run when it has not', () => {
    const document = documentV3(seasons);
    expect(reviewTextV3(document)).not.toContain('Support check');
    expect(reviewTextV3(document, undefined, null)).toContain('Support check: not run for this revision yet.');
  });
});
