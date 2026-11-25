import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { climbOneStop } from './ladder';
import { createVoyageController, descend, homeOf, type VoyageInputs } from './voyage-controller';

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
