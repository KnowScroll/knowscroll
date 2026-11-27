import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { climbOneStop } from './ladder';
import type { VoyageControl } from './voyage-control';
import { createVoyageController, descend, homeOf, shipLayoutOf, type VoyageInputs } from './voyage-controller';

/** The control the controller hands its renderer: the tests step its frames by hand. */
let mockControl: VoyageControl | undefined;
jest.mock('./voyage-loader', () => ({
  loadVoyageRenderer: (control: VoyageControl) => {
    mockControl = control;
    return () => Promise.reject(new Error('no renderer in a unit test'));
  },
}));

const descriptor = (objectId: string, parentId = 'system') => ({ objectId, parentId }) as never;

/** A session that only records where it was sent. */
function recordingSession() {
  const calls: string[] = [];
  const session = {
    focus: (id: string) => {
      calls.push(`focus ${id}`);
      return true;
    },
    up: () => {
      calls.push('up');
      return true;
    },
    land: () => {
      calls.push('land');
      return true;
    },
  } as unknown as UniverseMapSession;
  return { session, calls };
}

const anchor = (id: string, kind: SpaceAnchor['kind'], x: number, y: number, visible = true): SpaceAnchor => ({
  id,
  kind,
  name: id,
  systemId: null,
  x,
  y,
  radiusPx: 10,
  visible,
});

describe('one stop down', () => {
  it('goes from the whole universe to the visible system nearest the fingers', () => {
    const { session, calls } = recordingSession();
    const anchors = [
      anchor('far', 'system', 10, 10),
      anchor('near', 'system', 200, 300),
      anchor('hidden', 'system', 201, 301, false),
    ];
    descend(session, { kind: 'universe' }, anchors, 205, 305);
    expect(calls).toEqual(['focus near']);
  });

  it('goes from a star to its planet nearest the fingers, and from a planet to its ground', () => {
    const { session, calls } = recordingSession();
    descend(session, { kind: 'system', system: descriptor('s') }, [anchor('p', 'planet', 0, 0)], 0, 0);
    descend(session, { kind: 'planet', planet: descriptor('p'), landed: false }, [], 0, 0);
    descend(session, { kind: 'planet', planet: descriptor('p'), landed: true }, [], 0, 0);
    expect(calls).toEqual(['focus p', 'land']);
  });
});

describe('one stop up', () => {
  it('climbs from the ground to its planet’s globe, not past it to the star', () => {
    const { session, calls } = recordingSession();
    climbOneStop(session, { kind: 'planet', planet: descriptor('p'), landed: true });
    expect(calls).toEqual(['focus p']);
  });

  it('leaves a chosen region for the ground, a planet for its star and a star for the universe, as the pill always did', () => {
    const { session, calls } = recordingSession();
    const views: UniverseView[] = [
      { kind: 'planet', planet: descriptor('p'), landed: true, selectedRegion: descriptor('r', 'p') },
      { kind: 'planet', planet: descriptor('p'), landed: false },
      { kind: 'system', system: descriptor('s') },
    ];
    for (const view of views) climbOneStop(session, view);
    expect(calls).toEqual(['up', 'up', 'up']);
  });
});

describe('where the ship parks', () => {
  const size = { width: 390, height: 844 };

  it('stands just above the region the camera came down over', () => {
    const home = homeOf({ size, globe: null }, [anchor('r', 'region', 120, 400)], 'r', 0);
    expect(home).toMatchObject({ x: 120, y: 378 });
  });

  it('circles a globe seen from orbit', () => {
    const home = homeOf({ size, globe: { x: 195, y: 350, radiusPx: 140 } }, [], null, 0);
    expect(home.x).toBeCloseTo(195 + 140 * 1.34);
    expect(home.size).toBe(26);
  });

  it('waits low in the sky, never on top of something you could tap', () => {
    const free = homeOf({ size, globe: null }, [], null, 0);
    expect(free).toMatchObject({ x: 195, y: 844 * 0.675 });
    const crowded = homeOf({ size, globe: null }, [anchor('s', 'system', 195, 844 * 0.675)], null, 0);
    expect(crowded.x).not.toBe(195);
  });

  it('hovers gently while parked in the sky, and holds still with reduced motion', () => {
    const heights = [0, 0.4, 0.8, 1.2, 1.6, 2.0].map((seconds) => homeOf({ size, globe: null }, [], null, seconds).y);
    const park = 844 * 0.675;
    expect(Math.max(...heights) - park).toBeCloseTo(2.5, 0);
    expect(Math.max(...heights.map((y) => Math.abs(y - park)))).toBeLessThanOrEqual(2.5);
    for (const seconds of [0.4, 1.2, 2.0]) expect(homeOf({ size, globe: null }, [], null, seconds, true).y).toBe(park);
  });
});

describe('where the ship parks on a desktop', () => {
  const size = { width: 1352, height: 900 };

  it('uses the prototype’s desktop numbers: parked at 0.8 of the height, leaning from 0.6, free from 70 to H - 60', () => {
    expect(shipLayoutOf(true)).toEqual({ parkAt: 0.8, leanCentre: 0.6, margins: { side: 26, top: 70, bottom: 60 } });
    expect(shipLayoutOf(false)).toEqual({
      parkAt: 0.675,
      leanCentre: 0.56,
      margins: { side: 26, top: 150, bottom: 204 },
    });
  });

  it('waits at 0.8 of the height on a desktop and at 0.675 on a phone, on the same view', () => {
    expect(homeOf({ size, globe: null }, [], null, 0, true, true)).toMatchObject({ x: 676, y: 900 * 0.8 });
    expect(homeOf({ size, globe: null }, [], null, 0, true)).toMatchObject({ x: 676, y: 900 * 0.675 });
  });

  it('is where a finger takes it: the ship drawn at 0.8 of the height is picked up, an empty 0.675 is not', () => {
    const { session } = recordingSession();
    const lines: string[] = [];
    const controller = createVoyageController({
      session,
      view: { kind: 'universe' },
      target: { stop: 'universe', systemId: null, planetId: null, regionId: null },
      size,
      desktop: true,
      turn: { x: 0, y: 0 },
      planet: null,
      siblings: [],
      reducedMotion: false,
      universeFocus: {} as VoyageInputs['universeFocus'],
      systemFocus: () => undefined,
      onGesture: (line) => lines.push(line),
    });
    const handlers = controller.responder.panHandlers as unknown as Record<string, (event: unknown) => unknown>;
    const grant = (x: number, y: number) =>
      handlers['onStartShouldSetResponderCapture']!(touchEvent([{ id: 0, x, y }], 16));
    expect(grant(676, 900 * 0.675)).toBe(false);
    expect(grant(676, 900 * 0.8)).toBe(true);
  });
});

describe('keys', () => {
  it('turns by every arrow press, even several before the screen renders again', () => {
    const turns: { x: number; y: number }[] = [];
    const session = {
      camera: (frame: { x: number; y: number }) => {
        turns.push({ x: frame.x, y: frame.y });
        return true;
      },
    } as unknown as UniverseMapSession;
    const controller = createVoyageController({
      session,
      view: { kind: 'system' } as never,
      target: { stop: 'star', systemId: 'system', planetId: null, regionId: null } as never,
      size: { width: 390, height: 844 },
      turn: { x: 0, y: 0 },
      planet: null,
      siblings: [],
      reducedMotion: false,
      universeFocus: { kind: 'universe' } as never,
      systemFocus: () => undefined,
    });
    controller.key('ArrowRight');
    controller.key('ArrowRight');
    controller.key('ArrowUp');
    expect(turns).toEqual([
      { x: 60, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: -60 },
    ]);
  });
});

describe('one stop by key, the same as the wheel and the Back pill', () => {
  const universe: UniverseView = { kind: 'universe' };
  const inputsFor = (session: UniverseMapSession, view: UniverseView): VoyageInputs => ({
    session,
    view,
    target: { stop: 'universe', systemId: null, planetId: null, regionId: null },
    size: { width: 1352, height: 900 },
    desktop: true,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: {} as VoyageInputs['universeFocus'],
    systemFocus: () => undefined,
  });

  it('goes one stop in on + and = toward what is in the middle, and one stop out on -', () => {
    const { session, calls } = recordingSession();
    const controller = createVoyageController(inputsFor(session, universe));
    controller.setAnchors([anchor('far', 'system', 20, 20), anchor('middle', 'system', 700, 440)]);
    expect(controller.key('+')).toBe(true);
    expect(controller.key('=')).toBe(true);
    expect(controller.key('-')).toBe(true);
    expect(calls).toEqual(['focus middle', 'focus middle', 'up']);
  });
});

describe('the key that opens the planet’s map', () => {
  const ground: UniverseView = { kind: 'planet', planet: descriptor('p'), landed: true };
  const inputsFor = (session: UniverseMapSession, onMap?: () => void): VoyageInputs => ({
    session,
    view: ground,
    target: { stop: 'ground', systemId: 's', planetId: 'p', regionId: null },
    size: { width: 1352, height: 900 },
    desktop: true,
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: {} as VoyageInputs['universeFocus'],
    systemFocus: () => undefined,
    ...(onMap ? { onMap } : {}),
  });

  it('opens it on M in either case, and says it acted', () => {
    const { session, calls } = recordingSession();
    const onMap = jest.fn();
    const controller = createVoyageController(inputsFor(session, onMap));
    expect(controller.key('m')).toBe(true);
    expect(controller.key('M')).toBe(true);
    expect(onMap).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([]);
  });

  it('does nothing where no map can open', () => {
    const { session, calls } = recordingSession();
    const controller = createVoyageController(inputsFor(session));
    expect(controller.key('m')).toBe(false);
    expect(controller.key('M')).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('the wheel', () => {
  const landed: UniverseView = { kind: 'planet', planet: descriptor('p'), landed: true };
  const inputsFor = (session: UniverseMapSession): VoyageInputs => ({
    session,
    view: landed,
    target: { stop: 'ground', systemId: 's', planetId: 'p', regionId: null },
    size: { width: 390, height: 844 },
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: {} as VoyageInputs['universeFocus'],
    systemFocus: () => undefined,
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('moves one stop, then rests before it moves another', () => {
    const { session, calls } = recordingSession();
    const controller = createVoyageController(inputsFor(session));
    controller.wheel(100);
    controller.wheel(100);
    expect(calls).toEqual(['focus p']);
    jest.advanceTimersByTime(300);
    controller.wheel(100);
    expect(calls).toEqual(['focus p', 'focus p']);
  });

  it('leaves no timer behind when the stage goes, and is ready again if the stage stays', () => {
    const { session, calls } = recordingSession();
    const controller = createVoyageController(inputsFor(session));
    controller.wheel(100);
    expect(jest.getTimerCount()).toBe(1);
    controller.dispose();
    expect(jest.getTimerCount()).toBe(0);
    controller.wheel(100);
    expect(calls).toEqual(['focus p', 'focus p']);
  });
});

/** A finger as React Native reports it: its identifier and where it is on the page. */
type Touch = { readonly id: number; readonly x: number; readonly y: number };

/** The responder event of fingers `down`, with the touch history PanResponder reads its deltas from. */
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

describe('the fingers on the stage', () => {
  const universe: UniverseView = { kind: 'universe' };
  const inputsFor = (session: UniverseMapSession, onGesture: (line: string) => void): VoyageInputs => ({
    session,
    view: universe,
    target: { stop: 'universe', systemId: null, planetId: null, regionId: null },
    size: { width: 390, height: 844 },
    turn: { x: 0, y: 0 },
    planet: null,
    siblings: [],
    reducedMotion: false,
    universeFocus: {} as VoyageInputs['universeFocus'],
    systemFocus: () => undefined,
    onGesture,
  });
  /** A stage over the whole universe with one star at (200, 380), driven through its responder as touches arrive. */
  function stage() {
    const { session, calls } = recordingSession();
    const lines: string[] = [];
    const controller = createVoyageController(inputsFor(session, (line) => lines.push(line)));
    controller.setAnchors([anchor('star', 'system', 200, 380)]);
    const handlers = controller.responder.panHandlers as unknown as Record<string, (event: unknown) => unknown>;
    let time = 0;
    const fingers = (phase: 'start' | 'move' | 'end', down: readonly Touch[]) => {
      time += 16;
      const event = touchEvent(down, time);
      if (phase === 'start' && handlers['onResponderGrant'] && !granted) {
        granted = true;
        handlers['onResponderGrant'](event);
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
    let granted = false;
    return { controller, calls, lines, fingers };
  }

  it('says a gesture has just been made, for a moment, so a click after a drag is not a tap on bare ground', () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(1000);
    const { controller, fingers } = stage();
    expect(controller.justGestured()).toBe(false);
    fingers('start', [
      { id: 0, x: 170, y: 380 },
      { id: 1, x: 230, y: 380 },
    ]);
    expect(controller.justGestured()).toBe(true);
    now.mockReturnValue(1349);
    expect(controller.justGestured()).toBe(true);
    now.mockReturnValue(1351);
    expect(controller.justGestured()).toBe(false);
    now.mockRestore();
  });

  it('pause a pinch when one finger lifts, carry it on when a finger lands again, and decide when the last one lifts', () => {
    const { calls, lines, fingers } = stage();
    fingers('start', [
      { id: 0, x: 170, y: 380 },
      { id: 1, x: 230, y: 380 },
    ]);
    fingers('move', [
      { id: 0, x: 155, y: 380 },
      { id: 1, x: 245, y: 380 },
    ]);
    // One finger lifts: nothing moves a stop yet, and the name under the other finger stays where it is.
    fingers('end', [{ id: 0, x: 155, y: 380 }]);
    expect(lines.at(-1)).toBe('pinch ×1.50 · a finger lifted');
    expect(calls).toEqual([]);
    // It lands again close to the other: the pinch goes on from ×1.50, it does not jump back to ×1.
    fingers('start', [
      { id: 0, x: 155, y: 380 },
      { id: 2, x: 215, y: 380 },
    ]);
    expect(lines.at(-1)).toBe('pinch ×1.50');
    fingers('move', [
      { id: 0, x: 155, y: 380 },
      { id: 2, x: 245, y: 380 },
    ]);
    expect(lines.at(-1)).toBe('pinch ×2.25');
    fingers('end', [{ id: 2, x: 245, y: 380 }]);
    fingers('end', []);
    expect(calls).toEqual(['focus star']);
    expect(lines.at(-1)).toBe('pinch ×2.25 → in (a stop is ×1.40)');
  });

  it('let go of the ship when a second finger comes, so the ship is not left held after the pinch', () => {
    const { calls, lines, fingers } = stage();
    // The ship parks at the middle, 0.675 of the way down.
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    expect(lines.at(-1)).toBe('ship held');
    fingers('move', [{ id: 0, x: 195, y: 540 }]);
    fingers('start', [
      { id: 0, x: 195, y: 540 },
      { id: 1, x: 195, y: 470 },
    ]);
    expect(lines).toContain('ship → home: a second finger came');
    fingers('end', []);
    expect(lines.at(-1)).toBe('pinch ×1.00 → back (a stop is ×1.40)');
    expect(calls).toEqual([]);
  });

  it('draw a ship let go near a star into it, then fly there', () => {
    const { calls, lines, fingers } = stage();
    const frame = () =>
      mockControl!.afterFrame?.({
        dt: 1 / 30,
        flying: false,
        globe: null,
        size: { width: 390, height: 844 },
        programs: 0,
      });
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    // 130 pt left of the star: today's pull never reached this far.
    for (let step = 1; step <= 20; step++) {
      fingers('move', [{ id: 0, x: 195 - (125 * step) / 20, y: 570 - (190 * step) / 20 }]);
      frame();
    }
    for (let step = 0; step < 30; step++) frame();
    expect(lines.at(-1)).toMatch(/^ship held · pulled to star \((gently|firmly|strongly)\)$/);
    fingers('end', []);
    expect(lines.at(-1)).toBe('ship let go → drawn into star');
    expect(calls).toEqual([]);
    for (let step = 0; step < 60 && calls.length === 0; step++) frame();
    expect(calls).toEqual(['focus star']);
    expect(lines.at(-1)).toBe('ship drawn in → star');
  });

  it('stop drawing the ship in when a pinch begins: nothing flies but what the pinch asks for', () => {
    const { calls, lines, fingers } = stage();
    const frame = () =>
      mockControl!.afterFrame?.({
        dt: 1 / 30,
        flying: false,
        globe: null,
        size: { width: 390, height: 844 },
        programs: 0,
      });
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    for (let step = 1; step <= 20; step++) {
      fingers('move', [{ id: 0, x: 195 - (125 * step) / 20, y: 570 - (190 * step) / 20 }]);
      frame();
    }
    for (let step = 0; step < 30; step++) frame();
    fingers('end', []);
    expect(lines.at(-1)).toBe('ship let go → drawn into star');
    frame();
    fingers('start', [
      { id: 1, x: 170, y: 600 },
      { id: 2, x: 230, y: 600 },
    ]);
    for (let step = 0; step < 60; step++) frame();
    fingers('end', [{ id: 2, x: 230, y: 600 }]);
    fingers('end', []);
    for (let step = 0; step < 60; step++) frame();
    expect(calls).toEqual([]);
  });

  it('fly the ship by W A S D, pulled as a finger would pull it, and let it go when the keys rest', () => {
    jest.useFakeTimers();
    try {
      const { controller, calls, lines } = stage();
      const frame = () =>
        mockControl!.afterFrame?.({
          dt: 1 / 30,
          flying: false,
          globe: null,
          size: { width: 390, height: 844 },
          programs: 0,
        });
      frame();
      // The ship parks at (195, 570) and the star is at (200, 380): eight presses of W take it most of the way.
      for (let press = 0; press < 8; press++) {
        expect(controller.key(press % 2 === 0 ? 'w' : 'W')).toBe(true);
        for (let step = 0; step < 4; step++) frame();
      }
      for (let step = 0; step < 30; step++) frame();
      expect(lines).toContain('ship flown by keys');
      expect(lines.at(-1)).toMatch(/^ship held · pulled to star/);
      expect(calls).toEqual([]);
      jest.advanceTimersByTime(700);
      for (let step = 0; step < 60 && calls.length === 0; step++) frame();
      expect(calls).toEqual(['focus star']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('let go of a ship the keys hold, with no drop, when a flight starts before the keys rest', () => {
    jest.useFakeTimers();
    try {
      const { session, calls } = recordingSession();
      const first = inputsFor(session, () => undefined);
      const controller = createVoyageController(first);
      controller.setAnchors([anchor('star', 'system', 200, 380)]);
      const frame = () =>
        mockControl!.afterFrame?.({
          dt: 1 / 30,
          flying: false,
          globe: null,
          size: { width: 390, height: 844 },
          programs: 0,
        });
      frame();
      for (let press = 0; press < 8; press++) {
        controller.key('w');
        for (let step = 0; step < 4; step++) frame();
      }
      // A tap on a place flies there: the screen hands the controller a new target.
      controller.sync({ ...first, target: { stop: 'star', systemId: 'star', planetId: null, regionId: null } });
      jest.advanceTimersByTime(700);
      for (let step = 0; step < 30; step++) frame();
      expect(calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('the ship keys, against everything else', () => {
    const keysStage = () => {
      const { session, calls } = recordingSession();
      const camera = jest.fn();
      (session as unknown as { camera: typeof camera }).camera = camera;
      const lines: string[] = [];
      const controller = createVoyageController(inputsFor(session, (line) => lines.push(line)));
      controller.setAnchors([anchor('star', 'system', 200, 380)]);
      const handlers = controller.responder.panHandlers as unknown as Record<string, (event: unknown) => unknown>;
      let time = 0;
      const touchAt = (phase: 'grant' | 'start' | 'move' | 'end' | 'release', down: readonly Touch[]) => {
        time += 16;
        const name = {
          grant: 'onResponderGrant',
          start: 'onResponderStart',
          move: 'onResponderMove',
          end: 'onResponderEnd',
          release: 'onResponderRelease',
        }[phase];
        handlers[name]!(touchEvent(down, time));
      };
      const frame = (flying = false) =>
        mockControl!.afterFrame?.({ dt: 1 / 30, flying, globe: null, size: { width: 390, height: 844 }, programs: 0 });
      const pressW = (times: number) => {
        for (let press = 0; press < times; press++) {
          controller.key('w');
          for (let step = 0; step < 4; step++) frame();
        }
      };
      return { controller, calls, lines, camera, touchAt, frame, pressW };
    };
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('never turn the view', () => {
      const { pressW, camera, frame } = keysStage();
      frame();
      pressW(3);
      expect(camera).not.toHaveBeenCalled();
    });

    it('leave nothing behind when the stage goes: no let-go after it', () => {
      const { controller, calls, frame, pressW } = keysStage();
      frame();
      pressW(8);
      controller.dispose();
      jest.advanceTimersByTime(2000);
      for (let step = 0; step < 30; step++) frame();
      expect(calls).toEqual([]);
    });

    it('do nothing while the ship is hidden for a flight, even once they hold it', () => {
      const { controller, frame, pressW } = keysStage();
      frame();
      pressW(2);
      for (let step = 0; step < 20; step++) frame(true);
      expect(controller.key('w')).toBe(false);
    });

    it('give the ship up, with no drop, when two fingers begin a pinch', () => {
      const { controller, calls, touchAt, frame, pressW } = keysStage();
      frame();
      pressW(8);
      touchAt('grant', [
        { id: 1, x: 120, y: 650 },
        { id: 2, x: 260, y: 650 },
      ]);
      expect(controller.key('w')).toBe(false);
      jest.advanceTimersByTime(2000);
      for (let step = 0; step < 30; step++) frame();
      touchAt('end', []);
      touchAt('release', []);
      expect(calls).toEqual([]);
    });

    it('give the ship to a finger that takes it: the keys no longer let it go', () => {
      const { calls, touchAt, frame, pressW, lines } = keysStage();
      frame();
      pressW(2);
      const at = { id: 0, x: 195, y: 526 };
      touchAt('grant', [at]);
      expect(lines.at(-1)).toBe('ship held');
      jest.advanceTimersByTime(2000);
      for (let step = 0; step < 10; step++) frame();
      expect(calls).toEqual([]);
      expect(lines.at(-1)).not.toMatch(/let go/);
    });
  });

  it('leave the ship keys to the ship: they never turn the view, and do nothing while a finger holds it', () => {
    const { controller, fingers } = stage();
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    expect(controller.key('d')).toBe(false);
    fingers('end', []);
    expect(controller.key('x')).toBe(false);
  });

  it('take a shaking finger on the ship for a tap, not a drop', () => {
    const { calls, lines, fingers } = stage();
    fingers('start', [{ id: 0, x: 195, y: 570 }]);
    fingers('move', [{ id: 0, x: 197, y: 572 }]);
    fingers('end', []);
    expect(lines.at(-1)).toBe('ship tapped → home');
    expect(calls).toEqual([]);
  });
});
