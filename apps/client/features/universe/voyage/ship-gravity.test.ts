import { bendAt, MAX_TOTAL_BEND, onLettingGo, PLACE_PULL, pullGoal, pullOf, type PullingPlace } from './ship-gravity';

const star = (id: string, x: number, y: number, radius = 12): PullingPlace => ({
  id,
  x,
  y,
  pull: pullOf('system', radius),
});
const planet = (id: string, x: number, y: number, radius = 16): PullingPlace => ({
  id,
  x,
  y,
  pull: pullOf('planet', radius),
});

describe('how far and how hard a place pulls', () => {
  it('gives a star more reach and more bend than a planet, and a planet more than a place that is not a body', () => {
    const sun = pullOf('system', 10);
    const world = pullOf('planet', 10);
    expect(sun.reach).toBeGreaterThan(world.reach);
    expect(sun.bend).toBeGreaterThan(world.bend);
    expect(world.reach).toBeGreaterThan(PLACE_PULL.reach);
    expect(world.bend).toBeGreaterThan(PLACE_PULL.bend);
  });

  it('keeps the prototype’s pull for regions and rooms: 0.45 within 64 pt, caught within 70, never drawn in', () => {
    for (const kind of ['region', 'station']) expect(pullOf(kind, 30)).toEqual(PLACE_PULL);
    expect(PLACE_PULL).toMatchObject({ reach: 64, bend: 0.45, capture: 70, fall: 0 });
    const region: PullingPlace = { id: 'r', x: 0, y: 0, pull: PLACE_PULL };
    expect(bendAt(region, { x: 32, y: 0 })).toBeCloseTo(0.45 * 0.5);
  });

  it('grows a body’s reach and catch with its size on screen', () => {
    const small = pullOf('system', 4);
    const large = pullOf('system', 60);
    expect(large.reach - small.reach).toBe(56);
    expect(large.capture - small.capture).toBe(56);
    expect(large.fall - small.fall).toBe(56);
    expect(large.core - small.core).toBe(56);
    expect(large.size).toBe(60);
  });

  it('fades with distance from its full bend to nothing at the edge of its reach, without a jolt at the edge', () => {
    const sun = star('s', 0, 0);
    const at = (distance: number) => bendAt(sun, { x: distance, y: 0 });
    expect(at(0)).toBeCloseTo(sun.pull.bend);
    expect(at(sun.pull.reach)).toBe(0);
    expect(at(sun.pull.reach + 50)).toBe(0);
    for (let d = 10; d < sun.pull.reach; d += 10) expect(at(d)).toBeLessThan(at(d - 10));
    // Entering the reach, the bend rises from nothing: a step of 1 pt in from the edge bends by almost nothing.
    expect(at(sun.pull.reach - 1)).toBeLessThan(0.001);
  });

  it('is still felt 100 pt from a star, where the prototype’s pull is gone', () => {
    expect(bendAt(star('s', 0, 0), { x: 100, y: 0 })).toBeGreaterThan(0.15);
    expect(bendAt({ id: 'p', x: 0, y: 0, pull: PLACE_PULL }, { x: 100, y: 0 })).toBe(0);
  });
});

describe('bending the held ship’s goal', () => {
  it('leaves the goal on the finger when nothing is in reach', () => {
    expect(pullGoal({ x: 10, y: 10 }, [star('s', 500, 500)], null)).toEqual({
      x: 10,
      y: 10,
      candidate: null,
      strength: 0,
    });
  });

  it('bends toward the body and names it, with its strength', () => {
    const sun = star('s', 100, 0);
    const pulled = pullGoal({ x: 0, y: 0 }, [sun], null);
    expect(pulled.candidate).toBe('s');
    expect(pulled.x).toBeCloseTo(100 * bendAt(sun, { x: 0, y: 0 }));
    expect(pulled.y).toBe(0);
    expect(pulled.strength).toBeCloseTo(bendAt(sun, { x: 0, y: 0 }) / sun.pull.bend);
  });

  it('never takes the ship from the finger: all the pulls together bend less than the whole way', () => {
    const crowd = [star('a', 5, 0), star('b', -5, 0), star('c', 0, 5), planet('d', 0, -5)];
    const pulled = pullGoal({ x: 0, y: 0 }, crowd, null);
    const sameSide = [star('a', 40, 0), star('b', 42, 0), star('c', 44, 0)];
    const leaning = pullGoal({ x: 0, y: 0 }, sameSide, null);
    expect(Math.abs(pulled.x)).toBeLessThan(5);
    expect(leaning.x).toBeLessThanOrEqual(44 * MAX_TOTAL_BEND + 1e-9);
    expect(MAX_TOTAL_BEND).toBeLessThan(1);
  });

  it('keeps the place it chose until the finger is clearly nearer another, so the glow does not flicker between two', () => {
    const a = star('a', -60, 0);
    const b = star('b', 60, 0);
    // A finger a little nearer b than a: b is chosen afresh, but a, once chosen, is kept.
    const finger = { x: 5, y: 0 };
    expect(pullGoal(finger, [a, b], null).candidate).toBe('b');
    expect(pullGoal(finger, [a, b], 'a').candidate).toBe('a');
    // Well over to b's side it does take over.
    expect(pullGoal({ x: 40, y: 0 }, [a, b], 'a').candidate).toBe('b');
  });

  it('lets a room the finger is on win over the star beside it, and the star win with the finger on the star', () => {
    const sun = star('sun', 0, 0);
    const room: PullingPlace = { id: 'room', x: 36, y: 0, pull: PLACE_PULL };
    expect(pullGoal({ x: 36, y: 0 }, [sun, room], 'sun').candidate).toBe('room');
    expect(pullGoal({ x: 0, y: 0 }, [sun, room], 'room').candidate).toBe('sun');
    expect(pullGoal({ x: 0, y: 0 }, [sun, room], null).candidate).toBe('sun');
    expect(pullGoal({ x: 140, y: 0 }, [sun, room], 'room').candidate).toBe('sun');
  });

  it('counts a finger on a big body’s disc as on it', () => {
    const sun = star('sun', 0, 0, 60);
    const planetBeside = planet('planet', 90, 0, 10);
    // 50 pt from the sun's middle is inside its disc; the planet's edge is 30 pt away.
    expect(pullGoal({ x: 50, y: 0 }, [sun, planetBeside], null).candidate).toBe('sun');
  });

  it('drops a chosen body that is out of reach', () => {
    expect(pullGoal({ x: 0, y: 0 }, [star('far', 900, 0), star('near', 50, 0)], 'far').candidate).toBe('near');
  });
});

describe('letting go', () => {
  const pull = pullOf('system', 10);

  it('goes at once inside the catch, is drawn in a little farther out, and stays beyond that', () => {
    expect(onLettingGo(pull, pull.capture - 1)).toBe('go');
    expect(onLettingGo(pull, pull.capture + 1)).toBe('fall');
    expect(onLettingGo(pull, pull.fall - 1)).toBe('fall');
    expect(onLettingGo(pull, pull.fall + 1)).toBe('stay');
  });

  it('never draws the ship into a room or a region: only a drop on it counts', () => {
    expect(onLettingGo(PLACE_PULL, 69)).toBe('go');
    expect(onLettingGo(PLACE_PULL, 71)).toBe('stay');
  });
});
