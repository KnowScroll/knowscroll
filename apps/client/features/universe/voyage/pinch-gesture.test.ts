import { createPinchGesture } from './pinch-gesture';
import type { VoyageControl } from './voyage-control';

const control = (): Pick<VoyageControl, 'zoom'> => ({ zoom: null });

describe('a pinch', () => {
  it('moves the camera with the fingers, toward the place under them, within its range', () => {
    const shared = control();
    const pinch = createPinchGesture(shared);
    pinch.begin(100, 'star-a');
    pinch.move(200, true);
    expect(shared.zoom).toEqual({ scale: 0.5, toward: 'star-a' });
    pinch.move(10, true);
    expect(shared.zoom?.scale).toBe(3);
    pinch.move(1000, true);
    expect(shared.zoom?.scale).toBe(0.35);
    expect(pinch.pinching()).toBe(true);
  });

  it('does not move the camera under reduced motion, and still steps on release', () => {
    const shared = control();
    const pinch = createPinchGesture(shared);
    const steps: string[] = [];
    pinch.begin(100, null);
    pinch.move(200, false);
    expect(shared.zoom).toBeNull();
    pinch.end((direction) => steps.push(direction) > 0);
    expect(steps).toEqual(['in']);
  });

  it('steps in or out past 1.4, and holds the camera until the flight starts', () => {
    const shared = control();
    const pinch = createPinchGesture(shared);
    const steps: string[] = [];
    pinch.begin(100, 'star-a');
    pinch.move(150, true);
    pinch.end((direction) => steps.push(direction) > 0);
    expect(steps).toEqual(['in']);
    expect(shared.zoom).not.toBeNull();
    pinch.frame(0.1);
    expect(shared.zoom).not.toBeNull();
    pinch.targetChanged();
    expect(shared.zoom).toBeNull();

    pinch.begin(140, null);
    pinch.move(90, true);
    pinch.end((direction) => steps.push(direction) > 0);
    expect(steps).toEqual(['in', 'out']);
  });

  it('lets the camera ease back when short of a step, when there is nowhere to go, or after waiting for a flight', () => {
    const shared = control();
    const pinch = createPinchGesture(shared);
    pinch.begin(100, null);
    pinch.move(120, true);
    pinch.end(() => true);
    expect(shared.zoom).toBeNull();

    pinch.begin(100, null);
    pinch.move(200, true);
    pinch.end(() => false);
    expect(shared.zoom).toBeNull();

    pinch.begin(100, 'star-a');
    pinch.move(200, true);
    pinch.end(() => true);
    pinch.frame(0.3);
    expect(shared.zoom).not.toBeNull();
    pinch.frame(0.3);
    expect(shared.zoom).toBeNull();
  });

  it('lets go of the camera when the gesture is taken away', () => {
    const shared = control();
    const pinch = createPinchGesture(shared);
    pinch.begin(100, null);
    pinch.move(180, true);
    pinch.cancel();
    expect(shared.zoom).toBeNull();
    expect(pinch.pinching()).toBe(false);
  });
});
