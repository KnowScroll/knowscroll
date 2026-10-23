import { boundedFrame, INITIAL_FRAME, returnLocator } from './universe-camera';
import { fixtureId } from './universe.fixture';

describe('Universe camera, authored CI geometry only', () => {
  it('uses finite bounded camera coordinates and exact canonical return metadata', () => {
    expect(boundedFrame({ x: Infinity, y: -20000, scale: NaN })).toEqual({ x: 0, y: -10000, scale: 1 });
    expect(boundedFrame({ x: 0, y: 0, scale: 100 }).scale).toBe(16);
    const frame = { x: 12.25, y: -83, scale: 0.75 };
    expect(returnLocator(fixtureId(10000), fixtureId(12), frame).frame).toEqual(frame);
  });

  it('starts every view at the neutral frame, which a copy never aliases', () => {
    expect(INITIAL_FRAME).toEqual({ x: 0, y: 0, scale: 1 });
    expect({ ...INITIAL_FRAME }).not.toBe(INITIAL_FRAME);
  });
});
