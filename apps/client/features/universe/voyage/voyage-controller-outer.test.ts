import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseMapSession } from '../universe-session';
import { createOuterStop, type OuterStop } from './outer/outer-stop';
import type { UniverseOnScreen, VoyageControl } from './voyage-control';
import { createVoyageController, homeOf, type VoyageInputs } from './voyage-controller';

/** The control the controller hands its renderer: the tests step its frames by hand. */
let mockControl: VoyageControl | undefined;
jest.mock('./voyage-loader', () => ({
  loadVoyageRenderer: (control: VoyageControl) => {
    mockControl = control;
    return () => Promise.reject(new Error('no renderer in a unit test'));
  },
}));

const size = { width: 390, height: 844 };
const at = (stop: 'universe' | 'outer') => ({ stop, systemId: null, planetId: null, regionId: null }) as const;

/** A session that records where it was sent, and every turn of the stored camera. */
function recordingSession() {
  const calls: string[] = [];
  const session = {
    focus: (id: string) => (calls.push(`focus ${id}`), true),
    up: () => (calls.push('up'), true),
    land: () => (calls.push('land'), true),
    camera: () => (calls.push('camera'), true),
  } as unknown as UniverseMapSession;
  return { session, calls };
}

const star = (x: number, y: number): SpaceAnchor => ({
  id: 'star',
  kind: 'system',
  name: 'star',
  systemId: null,
  x,
  y,
  radiusPx: 10,
  visible: true,
});

/** A stage over the whole universe, with an outer stop, as the screen hands the controller its inputs. */
function stageOf(
  options: { clamp?: VoyageInputs['clampOuterPan']; reducedMotion?: boolean; outer?: OuterStop | null } = {},
) {
  const { session, calls } = recordingSession();
  const outer = options.outer === undefined ? createOuterStop() : options.outer;
  const lines: string[] = [];
  const inputs = (): VoyageInputs => ({
    session,
    view: { kind: 'universe' },
    target: at(outer?.getState().on === true ? 'outer' : 'universe'),
    size,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: options.reducedMotion ?? false,
    universeFocus: {} as VoyageInputs['universeFocus'],
    systemFocus: () => undefined,
    onGesture: (line) => lines.push(line),
    ...(outer === null ? {} : { outer }),
    ...(options.clamp ? { clampOuterPan: options.clamp } : {}),
  });
  const controller = createVoyageController(inputs());
  // The loader mock keeps the last control made: this stage's own is taken before another is created.
  const control = mockControl!;
  controller.setAnchors([star(200, 380)]);
  /** What the screen does after a store change: a render, which hands the controller the new target. */
  const rerender = () => controller.sync(inputs());
  const frame = (over: Partial<Parameters<NonNullable<VoyageControl['afterFrame']>>[0]> = {}) =>
    control.afterFrame?.({ dt: 1 / 30, flying: false, globe: null, size, programs: 0, ...over });
  return { controller, calls, lines, outer, rerender, frame, control: () => control };
}

/** A finger as React Native reports it. */
type Touch = { readonly id: number; readonly x: number; readonly y: number };
function touchEvent(down: readonly Touch[], time: number) {
  const touchBank: object[] = [];
  for (const touch of down)
    touchBank[touch.id] = {
      touchActive: true,
      startPageX: touch.x,
      startPageY: touch.y,
      startTimeStamp: time,
      currentPageX: touch.x,
      currentPageY: touch.y,
      currentTimeStamp: time,
      previousPageX: touch.x,
      previousPageY: touch.y,
      previousTimeStamp: time,
    };
  return {
    nativeEvent: {
      touches: down.map((touch) => ({ identifier: String(touch.id), pageX: touch.x, pageY: touch.y })),
      changedTouches: [],
      pageX: down[0]?.x ?? 0,
      pageY: down[0]?.y ?? 0,
    },
    touchHistory: {
      touchBank,
      numberActiveTouches: down.length,
      indexOfSingleActiveTouch: down.length === 1 ? down[0]!.id : -1,
      mostRecentTimeStamp: time,
    },
  } as never;
}

/** Drives a controller's responder with fingers, as the stage's panHandlers would be driven. */
function fingersOn(controller: ReturnType<typeof createVoyageController>) {
  const handlers = controller.responder.panHandlers as unknown as Record<string, (event: unknown) => unknown>;
  let time = 0;
  let granted = false;
  return (phase: 'start' | 'move' | 'end', down: readonly Touch[]) => {
    time += 16;
    const event = touchEvent(down, time);
    if (phase === 'start' && !granted) {
      granted = true;
      handlers['onResponderGrant']!(event);
    } else if (phase === 'start') handlers['onResponderStart']!(event);
    else if (phase === 'move') handlers['onResponderMove']!(event);
    else {
      handlers['onResponderEnd']!(event);
      if (down.length === 0) {
        handlers['onResponderRelease']!(event);
        granted = false;
      }
    }
  };
}

const pinchOut = (fingers: ReturnType<typeof fingersOn>) => {
  fingers('start', [
    { id: 0, x: 170, y: 300 },
    { id: 1, x: 230, y: 300 },
  ]);
  fingers('move', [
    { id: 0, x: 195, y: 300 },
    { id: 1, x: 205, y: 300 },
  ]);
  fingers('end', [{ id: 1, x: 205, y: 300 }]);
  fingers('end', []);
};
const pinchIn = (fingers: ReturnType<typeof fingersOn>) => {
  fingers('start', [
    { id: 0, x: 170, y: 300 },
    { id: 1, x: 230, y: 300 },
  ]);
  fingers('move', [
    { id: 0, x: 120, y: 300 },
    { id: 1, x: 280, y: 300 },
  ]);
  fingers('end', [{ id: 1, x: 280, y: 300 }]);
  fingers('end', []);
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** A stage already past the rim: the store is entered and the screen has rendered the new target. */
function pastTheRim(options: Parameters<typeof stageOf>[0] = {}) {
  const stage = stageOf(options);
  stage.outer!.enter();
  stage.rerender();
  stage.frame();
  return stage;
}

describe('going past the rim from the whole universe', () => {
  it('is what a pinch out let go, a wheel notch out and - do, and none of them adds a step to Back', () => {
    const ways = [
      (s: ReturnType<typeof stageOf>) => pinchOut(fingersOn(s.controller)),
      (s: ReturnType<typeof stageOf>) => s.controller.wheel(100),
      (s: ReturnType<typeof stageOf>) => expect(s.controller.key('-')).toBe(true),
    ];
    for (const out of ways) {
      const stage = stageOf();
      out(stage);
      expect(stage.outer!.getState().on).toBe(true);
      expect(stage.calls).toEqual([]);
    }
  });

  it('is as it always was when the screen has no outer stop: one stop up the ladder', () => {
    const stage = stageOf({ outer: null });
    stage.controller.wheel(100);
    jest.advanceTimersByTime(300);
    expect(stage.controller.key('-')).toBe(true);
    pinchOut(fingersOn(stage.controller));
    expect(stage.calls).toEqual(['up', 'up', 'up']);
  });

  it('leaves + and a wheel notch in as they were: toward the star in the middle', () => {
    const stage = stageOf();
    stage.controller.setAnchors([{ ...star(195, 420) }]);
    expect(stage.controller.key('+')).toBe(true);
    expect(stage.calls).toEqual(['focus star']);
    expect(stage.outer!.getState().on).toBe(false);
  });

  it('puts the field back at rest each time it is entered', () => {
    const stage = pastTheRim();
    stage.controller.key('ArrowLeft');
    expect(stage.controller.fieldPan()).toEqual({ x: 60, y: 0 });
    stage.outer!.leave();
    stage.rerender();
    stage.outer!.enter();
    stage.controller.wheel(100);
    stage.rerender();
    expect(stage.controller.fieldPan()).toEqual({ x: 0, y: 0 });
  });
});

describe('at the outer stop', () => {
  it('comes back on a pinch in, a wheel notch in, + and =, and never goes to a star', () => {
    const ways = [
      (s: ReturnType<typeof stageOf>) => pinchIn(fingersOn(s.controller)),
      (s: ReturnType<typeof stageOf>) => s.controller.wheel(-100),
      (s: ReturnType<typeof stageOf>) => expect(s.controller.key('+')).toBe(true),
      (s: ReturnType<typeof stageOf>) => expect(s.controller.key('=')).toBe(true),
    ];
    for (const back of ways) {
      const stage = pastTheRim();
      back(stage);
      expect(stage.outer!.getState().on).toBe(false);
      expect(stage.calls).toEqual([]);
    }
  });

  it('climbs nowhere: a pinch out, a wheel notch out and - do nothing, and the gesture line says why', () => {
    const stage = pastTheRim();
    stage.controller.wheel(100);
    expect(stage.lines.at(-1)).toBe('beyond your universe · nothing is farther out');
    stage.lines.length = 0;
    expect(stage.controller.key('-')).toBe(true);
    expect(stage.lines).toEqual([]);
    pinchOut(fingersOn(stage.controller));
    expect(stage.lines.at(-1)).toMatch(/→ nowhere/);
    expect(stage.outer!.getState().on).toBe(true);
    expect(stage.calls).toEqual([]);
  });

  it('never calls the session for a key or a wheel notch of any kind', () => {
    const stage = pastTheRim();
    for (const key of ['-', 'ArrowLeft', 'ArrowDown', 'Escape']) stage.controller.key(key);
    stage.controller.wheel(100);
    expect(stage.calls).toEqual([]);
  });
});

describe('moving the field at the outer stop', () => {
  it('follows a one-finger drag 1:1, held by the clamp, and never turns the stored camera', () => {
    const clamp = jest.fn((pan: { x: number; y: number }) => ({
      x: Math.max(-100, Math.min(100, pan.x)),
      y: Math.max(-100, Math.min(100, pan.y)),
    }));
    const stage = pastTheRim({ clamp });
    const fingers = fingersOn(stage.controller);
    fingers('start', [{ id: 0, x: 300, y: 300 }]);
    fingers('move', [{ id: 0, x: 260, y: 290 }]);
    expect(stage.controller.fieldPan()).toEqual({ x: -40, y: -10 });
    fingers('move', [{ id: 0, x: 100, y: 500 }]);
    expect(stage.controller.fieldPan()).toEqual({ x: -100, y: 100 });
    fingers('end', []);
    expect(stage.calls).toEqual([]);
    expect(clamp).toHaveBeenCalled();
  });

  it('leans the camera the other way: a field moved left is a view leaning right', () => {
    const stage = pastTheRim();
    const fingers = fingersOn(stage.controller);
    fingers('start', [{ id: 0, x: 300, y: 300 }]);
    fingers('move', [{ id: 0, x: 250, y: 320 }]);
    // Set at once, with no frame between: under reduced motion there is none.
    expect(stage.control().lean).toEqual({ x: 50, y: -20 });
    stage.frame();
    expect(stage.control().lean).toEqual({ x: 50, y: -20 });
  });

  it('moves by 60 points an arrow press, as looking round: left slides the field right', () => {
    const stage = pastTheRim();
    stage.controller.key('ArrowLeft');
    stage.controller.key('ArrowLeft');
    stage.controller.key('ArrowDown');
    expect(stage.controller.fieldPan()).toEqual({ x: 120, y: -60 });
    stage.controller.key('ArrowRight');
    expect(stage.controller.fieldPan()).toEqual({ x: 60, y: -60 });
    expect(stage.calls).toEqual([]);
  });

  it('tells a listener each time the field is moved, and says it was at rest away from the stop', () => {
    const stage = pastTheRim();
    const heard = jest.fn();
    const stop = stage.controller.subscribe(heard);
    stage.controller.key('ArrowUp');
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    stage.controller.key('ArrowUp');
    expect(heard).toHaveBeenCalledTimes(1);
    stage.outer!.leave();
    stage.rerender();
    expect(stage.controller.fieldPan()).toEqual({ x: 0, y: 0 });
  });

  it('multiplies the ship’s lean by 3, eased in over about 0.3 s, and holds the sum where the clamp says', () => {
    const outerStage = pastTheRim();
    const plain = stageOf();
    plain.frame();
    const drag = (stage: ReturnType<typeof stageOf>) => {
      const fingers = fingersOn(stage.controller);
      // The ship is parked in the middle, 0.675 of the way down: a finger takes it and drags it right.
      fingers('start', [{ id: 0, x: 195, y: 570 }]);
      for (let step = 1; step <= 10; step += 1) {
        fingers('move', [{ id: 0, x: 195 + step * 8, y: 570 }]);
        stage.frame();
      }
      for (let step = 0; step < 40; step += 1) stage.frame();
    };
    drag(plain);
    const own = plain.control().lean;
    drag(outerStage);
    expect(own.x).toBeGreaterThan(10);
    expect(outerStage.control().lean.x).toBeCloseTo(own.x * 3, 1);
    expect(outerStage.control().lean.y).toBeCloseTo(own.y * 3, 1);

    const held = pastTheRim({ clamp: (pan) => ({ x: Math.max(-50, Math.min(50, pan.x)), y: pan.y }) });
    drag(held);
    expect(held.control().lean.x).toBe(50);
  });

  it('starts the gain at 1, so entering the stop with the ship out does not move the view', () => {
    const stage = stageOf();
    const fingers = fingersOn(stage.controller);
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    fingers('move', [{ id: 0, x: 295, y: 570 }]);
    for (let step = 0; step < 40; step += 1) stage.frame();
    const before = stage.control().lean.x;
    fingers('end', []);
    stage.outer!.enter();
    stage.rerender();
    stage.frame({ dt: 0.001 });
    // Not three times as far (135): the gain eases in from 1.
    expect(Math.abs(stage.control().lean.x - before)).toBeLessThan(3);
  });

  it('fades the field’s lean into the ship’s when the stop is left, and at once under reduced motion', () => {
    const stage = pastTheRim();
    stage.controller.key('ArrowLeft');
    const held = stage.control().lean;
    expect(held.x).toBe(-60);
    stage.outer!.leave();
    stage.rerender();
    stage.frame();
    expect(stage.control().lean.x).toBeLessThan(0);
    expect(stage.control().lean.x).toBeGreaterThan(-60);
    for (let step = 0; step < 60; step += 1) stage.frame();
    expect(stage.control().lean).toEqual({ x: 0, y: 0 });

    const calm = pastTheRim({ reducedMotion: true });
    calm.controller.key('ArrowLeft');
    calm.outer!.leave();
    calm.rerender();
    calm.frame();
    expect(calm.control().lean).toEqual({ x: 0, y: 0 });
  });
});

describe('the ship at the outer stop', () => {
  const free = { size, globe: null };

  it('parks off the bubbles it is told of, and in the middle when it is told of none', () => {
    expect(homeOf(free, [], null, 0, true)).toMatchObject({ x: 195, y: 844 * 0.675 });
    const home = homeOf(free, [], null, 0, true, false, [{ x: 195, y: 844 * 0.675, r: 40 }]);
    expect(Math.hypot(home.x - 195, home.y - 844 * 0.675)).toBeGreaterThanOrEqual(40);
  });

  it('never makes a bubble a place to go to: the parked ship is let go over one and nothing flies', () => {
    const stage = pastTheRim();
    stage.controller.setAnchors([]);
    stage.controller.setObstacles([{ x: 195, y: 570, r: 40 }]);
    const fingers = fingersOn(stage.controller);
    for (let step = 0; step < 40; step += 1) stage.frame();
    const home = stage.frame();
    // The ship stepped aside from the bubble that was where it parks.
    expect(home?.x ?? 0).not.toBeCloseTo(195, 0);
    fingers('start', [{ id: 0, x: home?.x ?? 0, y: home?.y ?? 0 }]);
    fingers('move', [{ id: 0, x: 195, y: 560 }]);
    for (let step = 0; step < 60; step += 1) stage.frame();
    fingers('end', []);
    for (let step = 0; step < 60; step += 1) stage.frame();
    expect(stage.calls).toEqual([]);
  });
});

describe('what the layer is told of the universe', () => {
  const universe = (over: Partial<UniverseOnScreen>): UniverseOnScreen => ({
    x: 195,
    y: 410,
    radiusPx: 60,
    fade: 0.5,
    ...over,
  });

  it('is nothing while the field is out, and a snapshot once it is in', () => {
    const stage = stageOf();
    const heard = jest.fn();
    stage.controller.subscribe(heard);
    stage.frame({ universe: universe({ fade: 0 }) });
    stage.frame({ universe: universe({ fade: 0, x: 220 }) });
    stage.frame({ universe: null });
    expect(heard).not.toHaveBeenCalled();
    expect(stage.controller.universe()).toBeNull();
    stage.frame({ universe: universe({ fade: 0.2 }) });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(stage.controller.universe()).toMatchObject({ fade: 0.2 });
  });

  it('is told again only when the centre moved half a point, or the fade a hundredth', () => {
    const stage = stageOf();
    const heard = jest.fn();
    stage.frame({ universe: universe({ fade: 0.3 }) });
    stage.controller.subscribe(heard);
    stage.frame({ universe: universe({ fade: 0.305, x: 195.2 }) });
    expect(heard).not.toHaveBeenCalled();
    stage.frame({ universe: universe({ fade: 0.3, x: 195.6 }) });
    expect(heard).toHaveBeenCalledTimes(1);
    stage.frame({ universe: universe({ fade: 0.32, x: 195.6 }) });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('is told exactly at both ends of the fade, and nothing after', () => {
    const stage = stageOf();
    stage.frame({ universe: universe({ fade: 0.995 }) });
    const heard = jest.fn();
    stage.controller.subscribe(heard);
    stage.frame({ universe: universe({ fade: 1 }) });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(stage.controller.universe()).toMatchObject({ fade: 1 });
    stage.frame({ universe: universe({ fade: 0.004 }) });
    stage.frame({ universe: universe({ fade: 0 }) });
    expect(stage.controller.universe()).toBeNull();
    const before = heard.mock.calls.length;
    stage.frame({ universe: universe({ fade: 0, x: 300 }) });
    stage.frame({ universe: null });
    expect(heard.mock.calls.length).toBe(before);
  });
});
