import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { stageFigureAt } from './stage-figure';
import { stageEntryAt } from './stage-state';

const document = seasons as unknown as ScrollDocumentV2;
const stage = document.stage;
if (stage === undefined) throw new Error('the fixture has a stage');
const last = document.stops.at(-1)?.id ?? '';

describe('the figure a v2 stage shows (V3 F10)', () => {
  it('is the state that holds at a stop, named by the stop that set it', () => {
    const entry = stageEntryAt(stage, document.stops, 'same-direction');
    expect(stageFigureAt(stage, document.stops, 'same-direction')).toMatchObject({
      kind: 'state',
      key: entry.stop,
      alt: entry.alt,
    });
  });

  it('is the picture of the whole journey at the end, when the kit can draw one for these states', () => {
    expect(stageFigureAt(stage, document.stops, last, true)).toMatchObject({ kind: 'recap', key: 'recap' });
  });

  it('keeps the state at the stop, its key and its words, when the kit cannot draw the journey (one state, no orbit)', () => {
    const first = stage.states[0];
    if (first === undefined) throw new Error('the stage has a state');
    const short = { ...stage, states: [first] } as typeof stage;
    const entry = stageEntryAt(short, document.stops, last);
    expect(stageFigureAt(short, document.stops, last, true)).toEqual({
      kind: 'state',
      kit: stage.kit,
      state: entry.state,
      alt: entry.alt,
      key: entry.stop,
    });
  });
});
