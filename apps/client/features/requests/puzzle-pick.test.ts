import stageDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { pickPuzzle } from './puzzle-pick';

const document = stageDocument as unknown as ScrollDocumentV2;
const stopIds = document.stops.map((stop) => stop.id);
const callIts = document.stops.filter((stop) => stop.kind === 'call_it').map((stop) => stop.id);

/** The labelled fixture has two Call its and a Final call; the tests read their ids from it. */
describe('which call fills the wait', () => {
  it('is the latest call the person has already read, so it is fresh in their mind', () => {
    const [first, second] = callIts as [string, string];
    expect(pickPuzzle(document, new Set(), stopIds.at(-1)!)).toMatchObject({ id: second });
    const between = stopIds[stopIds.indexOf(first) + 1]!;
    expect(pickPuzzle(document, new Set(), between)).toMatchObject({ id: first });
    // Asking from a call stop counts that call as read.
    expect(pickPuzzle(document, new Set(), first)).toMatchObject({ id: first });
  });

  it('skips a call that was played, and takes the next one ahead when none read is left', () => {
    const [first, second] = callIts as [string, string];
    expect(pickPuzzle(document, new Set([second]), stopIds.at(-1)!)).toMatchObject({ id: first });
    expect(pickPuzzle(document, new Set([first]), stopIds[0]!)).toMatchObject({ id: second });
  });

  it('is never the Final call, and is none when every Call it was played', () => {
    expect(pickPuzzle(document, new Set(callIts), stopIds.at(-1)!)).toBeUndefined();
    expect(pickPuzzle(document, new Set(), stopIds.at(-1)!)?.kind).toBe('call_it');
  });

  it('falls back to the last call when the stop is not in the Scroll', () => {
    expect(pickPuzzle(document, new Set(), 'no-such-stop')?.kind).toBe('call_it');
  });
});
