import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { stageEntryAt } from './stage-state';

const document = seasons as unknown as ScrollDocumentV2;
const stage = document.stage;
if (stage === undefined) throw new Error('the fixture has a stage');

describe('the stage state at a stop', () => {
  it('is the state set at that stop, and the state before it for a stop that sets none', () => {
    expect(stageEntryAt(stage, document.stops, 'the-lean').stop).toBe('the-lean');
    // A call sets no state: it keeps the one before it, so the picture never shows an answer.
    expect(stageEntryAt(stage, document.stops, 'call-delhi').stop).toBe('same-direction');
    expect(stageEntryAt(stage, document.stops, 'long-days').stop).toBe('steeper-light');
    expect(stageEntryAt(stage, document.stops, 'final-sydney').stop).toBe('the-year');
  });

  it('is the first state for a stop it does not know', () => {
    expect(stageEntryAt(stage, document.stops, 'nowhere').stop).toBe('the-lean');
  });
});
