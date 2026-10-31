import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { passageOf, quickAnswerFor } from './quick-answer';

/** The labelled CI fixture (`seasons-stage-ci`), never product content. */
const document = seasons as unknown as ScrollDocumentV2;

describe('a Quick answer, made from the Scroll’s own words', () => {
  it('is the stop’s plainer words, with the passage the reader selected', () => {
    const answer = quickAnswerFor(document, 'the-lean', '  Earth is tilted  ');
    expect(answer).toEqual({
      stopId: 'the-lean',
      passage: 'Earth is tilted',
      body: 'Earth is tilted, and the tilt never changes direction.',
      beside: [],
    });
  });

  it('adds what the Scroll says beside that stop, and never the limits aside', () => {
    expect(quickAnswerFor(document, 'steeper-light', 'steeper')?.beside.map((aside) => aside.id)).toEqual([
      'tropics-tangent',
    ]);
    expect(quickAnswerFor(document, 'the-year', 'the year')?.beside).toEqual([]);
  });

  it('is not offered for a call or the Final call, whose words could give the answer away', () => {
    expect(quickAnswerFor(document, 'call-delhi', 'Delhi')).toBeUndefined();
    expect(quickAnswerFor(document, 'final-tilt', 'tilt')).toBeUndefined();
  });

  it('is not offered for a stop the Scroll does not have or for words that are only space', () => {
    expect(quickAnswerFor(document, 'no-such-stop', 'words')).toBeUndefined();
    expect(quickAnswerFor(document, 'the-lean', '   \n ')).toBeUndefined();
  });

  it('uses nothing from a later stop, so it cannot spoil a call that comes after', () => {
    const answer = quickAnswerFor(document, 'the-lean', 'tilted');
    const later = document.stops.filter((stop) => stop.kind !== 'read').flatMap((stop) => [stop.explain, stop.twist]);
    for (const words of later) expect(JSON.stringify(answer)).not.toContain(words);
  });

  it('echoes a long selection as one line of at most ninety letters', () => {
    const line = passageOf(`${'word '.repeat(60)}\n end`);
    expect([...line].length).toBeLessThanOrEqual(90);
    expect(line).not.toContain('\n');
    expect(line.endsWith('…')).toBe(true);
  });
});
