import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { challengeCallOf } from './challenge-call';

/** The labelled CI fixture (`seasons-stage-ci`), never product content. */
const document = seasons as unknown as ScrollDocumentV2;

describe('the call a Scroll challenges a friend with', () => {
  it('is the Final call when the Scroll has one', () => {
    const call = challengeCallOf(document);
    expect(call).toMatchObject({ stopId: 'final-tilt', kind: 'final_call' });
    expect(call?.options).toHaveLength(3);
  });

  it('is the first Call it when there is no Final call', () => {
    const withoutFinal = { stops: document.stops.filter((stop) => stop.kind !== 'final_call') };
    expect(challengeCallOf(withoutFinal)).toMatchObject({ stopId: 'call-delhi', kind: 'call_it' });
  });

  it('is nothing for a Scroll with no call', () => {
    expect(challengeCallOf({ stops: document.stops.filter((stop) => stop.kind === 'read') })).toBeUndefined();
  });

  it('carries the question and the options and never the answer', () => {
    const call = challengeCallOf(document)!;
    expect(Object.keys(call).toSorted()).toEqual(['kind', 'options', 'prompt', 'stopId']);
  });
});
