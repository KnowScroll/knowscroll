import { createStageTouches, type Finger, type StageGesture } from './stage-touches';

const finger = (id: number, x: number, y: number): Finger => ({ id: String(id), x, y });
/** A stage whose ship is parked at (195, 570), taken by a finger within 26 points. */
const onShip = (at: { x: number; y: number }) => Math.hypot(at.x - 195, at.y - 570) <= 26;
const kinds = (gestures: readonly StageGesture[]) => gestures.map((gesture) => gesture.kind);

describe('the fingers on the stage', () => {
  it('pinch with two fingers, and follow the spread of those two fingers', () => {
    const touches = createStageTouches();
    expect(touches.update([finger(0, 100, 400), finger(1, 160, 400)], onShip)).toEqual([
      { kind: 'pinch-begin', spread: 60, between: { x: 130, y: 400 }, resumes: false },
    ]);
    expect(touches.update([finger(0, 80, 400), finger(1, 180, 400)], onShip)).toEqual([
      { kind: 'pinch-move', spread: 100 },
    ]);
    expect(touches.update([], onShip)).toEqual([{ kind: 'pinch-end' }]);
    expect(touches.mode()).toBe('idle');
  });

  it('pause the pinch when one finger lifts, and end it only when the last one does', () => {
    const touches = createStageTouches();
    touches.update([finger(0, 100, 400), finger(1, 160, 400)], onShip);
    touches.update([finger(0, 60, 400), finger(1, 200, 400)], onShip);
    expect(kinds(touches.update([finger(0, 60, 400)], onShip))).toEqual(['pinch-pause']);
    // The finger left behind turns nothing.
    expect(touches.update([finger(0, 20, 300)], onShip)).toEqual([]);
    expect(touches.update([], onShip)).toEqual([{ kind: 'pinch-end' }]);
  });

  it('carry the pinch on from where the fingers are when a lifted finger lands again', () => {
    const touches = createStageTouches();
    touches.update([finger(0, 100, 400), finger(1, 160, 400)], onShip);
    touches.update([finger(0, 60, 400), finger(1, 210, 400)], onShip);
    touches.update([finger(0, 60, 400)], onShip);
    // The new finger lands close to the other: the new pinch is measured from this spread, not the old one.
    expect(touches.update([finger(0, 60, 400), finger(2, 120, 400)], onShip)).toEqual([
      { kind: 'pinch-begin', spread: 60, between: { x: 90, y: 400 }, resumes: true },
    ]);
    expect(touches.update([finger(0, 60, 400), finger(2, 180, 400)], onShip)).toEqual([
      { kind: 'pinch-move', spread: 120 },
    ]);
  });

  it('keep pinching with the same two fingers when a third lands, and carry on with a new pair if one of the two lifts', () => {
    const touches = createStageTouches();
    touches.update([finger(0, 100, 400), finger(1, 160, 400)], onShip);
    expect(touches.update([finger(0, 100, 400), finger(1, 170, 400), finger(2, 300, 600)], onShip)).toEqual([
      { kind: 'pinch-move', spread: 70 },
    ]);
    expect(touches.update([finger(1, 170, 400), finger(2, 300, 600)], onShip)).toEqual([
      { kind: 'pinch-pause' },
      { kind: 'pinch-begin', spread: Math.hypot(130, 200), between: { x: 235, y: 500 }, resumes: true },
    ]);
  });

  it('take the ship under a finger, and count it as moved only once the finger has moved 6 points', () => {
    const touches = createStageTouches();
    expect(touches.update([finger(0, 195, 570)], onShip)).toEqual([{ kind: 'ship-take', at: { x: 195, y: 570 } }]);
    // A finger always shakes a little: the ship follows it, and lifting it is still a tap.
    expect(touches.update([finger(0, 198, 572)], onShip)).toEqual([{ kind: 'ship-move', at: { x: 198, y: 572 } }]);
    expect(touches.update([], onShip)).toEqual([{ kind: 'ship-let-go', moved: false }]);

    touches.update([finger(0, 195, 570)], onShip);
    expect(touches.update([finger(0, 195, 560)], onShip)).toEqual([{ kind: 'ship-move', at: { x: 195, y: 560 } }]);
    expect(touches.update([finger(0, 196, 566)], onShip)).toEqual([{ kind: 'ship-move', at: { x: 196, y: 566 } }]);
    expect(touches.update([], onShip)).toEqual([{ kind: 'ship-let-go', moved: true }]);
  });

  it('let the ship go home when a second finger lands, and pinch instead', () => {
    const touches = createStageTouches();
    touches.update([finger(0, 195, 570)], onShip);
    touches.update([finger(0, 195, 540)], onShip);
    expect(touches.update([finger(0, 195, 540), finger(1, 195, 470)], onShip)).toEqual([
      { kind: 'ship-home' },
      { kind: 'pinch-begin', spread: 70, between: { x: 195, y: 505 }, resumes: false },
    ]);
    expect(kinds(touches.update([], onShip))).toEqual(['pinch-end']);
  });

  it('turn what is in front with one finger anywhere else', () => {
    const touches = createStageTouches();
    expect(touches.update([finger(0, 100, 300)], onShip)).toEqual([{ kind: 'turn-begin' }]);
    expect(touches.update([finger(0, 140, 290)], onShip)).toEqual([{ kind: 'turn', dx: 40, dy: -10 }]);
    expect(touches.update([], onShip)).toEqual([]);
  });

  it('turn from where a finger first moved, when the stage only took the touch once it had moved', () => {
    const touches = createStageTouches();
    expect(touches.update([finger(0, 110, 300)], onShip, { x: 10, y: 0 })).toEqual([
      { kind: 'turn-begin' },
      { kind: 'turn', dx: 10, dy: 0 },
    ]);
    expect(touches.update([finger(0, 130, 300)], onShip)).toEqual([{ kind: 'turn', dx: 30, dy: 0 }]);
  });

  it('forget everything when the gesture is taken away', () => {
    const touches = createStageTouches();
    touches.update([finger(0, 100, 400), finger(1, 160, 400)], onShip);
    touches.update([finger(0, 100, 400)], onShip);
    expect(touches.cancel()).toEqual([{ kind: 'pinch-cancel' }]);
    expect(touches.mode()).toBe('idle');
    touches.update([finger(0, 195, 570)], onShip);
    expect(touches.cancel()).toEqual([{ kind: 'ship-home' }]);
    expect(touches.cancel()).toEqual([]);
  });
});
