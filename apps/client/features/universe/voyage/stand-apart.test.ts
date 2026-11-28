import {
  STAND_APART_GAP,
  standApart,
  type Disc,
  type StationClears,
  type StationDisc,
  type SunDisc,
} from './stand-apart';

/** The sweeps close in on a gap that two suns leave room for only off the line between them: to a tenth of a point. */
const CLOSE = 0.1;

const sun = (systemId: string, x: number, y: number, radius = 12, reach = 80): SunDisc => ({
  systemId,
  x,
  y,
  radius,
  reach,
});
const station = (systemId: string, x: number, y: number, radius = 20): StationDisc => ({ systemId, x, y, radius });
const cloud = (x: number, y: number, radius = 40): Disc => ({ x, y, radius });

const solve = (
  suns: readonly SunDisc[],
  stations: readonly StationDisc[],
  dust: readonly Disc[] = [],
  stationClears: StationClears = 'sun',
) => standApart({ suns, stations, dust, stationClears });

const apart = (a: Disc, b: Disc): number => Math.hypot(a.x - b.x, a.y - b.y) - a.radius - b.radius;
const moved = <T extends Disc>(body: T, by: { x: number; y: number }): T => ({
  ...body,
  x: body.x + by.x,
  y: body.y + by.y,
});

describe('standing apart on screen', () => {
  it('moves nothing that is already clear', () => {
    const offsets = solve([sun('a', 100, 100)], [station('a', 200, 100)], [cloud(100, 400)]);
    expect(offsets.stations).toEqual([{ x: 0, y: 0 }]);
    expect(offsets.dust).toEqual([{ x: 0, y: 0 }]);
  });

  it('moves a station that touches a small sun straight out along the line from the sun, to a gap', () => {
    const home = sun('a', 100, 100);
    const touching = station('a', 120, 100);
    const [offset] = solve([home], [touching]).stations;
    expect(offset!.y).toBeCloseTo(0);
    expect(offset!.x).toBeGreaterThan(0);
    const placed = moved(touching, offset!);
    expect(apart(placed, home)).toBeCloseTo(STAND_APART_GAP);
  });

  it('pushes along a slanted line, away from the sun the station stands beside', () => {
    const home = sun('a', 100, 100);
    const [offset] = solve([home], [station('a', 90, 90)]).stations;
    expect(offset!.x).toBeLessThan(0);
    expect(offset!.y).toBeLessThan(0);
    expect(offset!.x / offset!.y).toBeCloseTo(1);
  });

  it('is continuous: a slightly nearer station moves slightly more', () => {
    const home = sun('a', 0, 0);
    const pushOf = (x: number) => solve([home], [station('a', x, 0)]).stations[0]!.x;
    expect(pushOf(43.8) - pushOf(44)).toBeCloseTo(0.2, 5);
    expect(pushOf(44.2)).toBe(0);
  });

  it('clears two suns at once when it stands across both', () => {
    // 80 apart, the two discs and the gaps leave room for the station only off the line between them.
    const left = sun('a', 100, 100);
    const right = sun('b', 180, 100);
    const across = station('a', 140, 108);
    const [offset] = solve([left, right], [across]).stations;
    const placed = moved(across, offset!);
    expect(apart(placed, left)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    expect(apart(placed, right)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
  });

  it('keeps two stations from overlapping, and from touching a sun while it does', () => {
    const home = sun('a', 100, 100);
    const first = station('a', 150, 100);
    const second = station('a', 160, 104);
    const offsets = solve([home], [first, second]).stations;
    const one = moved(first, offsets[0]!);
    const two = moved(second, offsets[1]!);
    expect(apart(one, two)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    expect(apart(one, home)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    expect(apart(two, home)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
  });

  it('gives the same offsets whichever station is listed first', () => {
    const suns = [sun('a', 100, 100)];
    const first = station('a', 150, 100);
    const second = station('a', 160, 104);
    const forward = solve(suns, [first, second]).stations;
    const backward = solve(suns, [second, first]).stations;
    expect(backward[0]!.x).toBeCloseTo(forward[1]!.x);
    expect(backward[1]!.y).toBeCloseTo(forward[0]!.y);
  });

  it('moves a cloud of dust that overlaps a sun, and one that overlaps a station, clear of them', () => {
    const home = sun('a', 100, 100);
    const stand = station('a', 300, 100);
    const [onSun, onStation] = solve([home], [stand], [cloud(110, 100), cloud(310, 110)]).dust;
    expect(apart(moved(cloud(110, 100), onSun!), home)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    expect(apart(moved(cloud(310, 110), onStation!), stand)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
  });

  it('clears the station as it was moved, not where it was built', () => {
    const home = sun('a', 100, 100);
    // The station overlaps the sun and is pushed to the right; a cloud just there must stand clear of it too.
    const stand = station('a', 120, 100);
    const offsets = solve([home], [stand], [cloud(190, 100, 30)]);
    const placed = moved(stand, offsets.stations[0]!);
    const dust = moved(cloud(190, 100, 30), offsets.dust[0]!);
    expect(apart(dust, placed)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    expect(apart(dust, home)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
  });

  it('clears the group of its own system, wherever that system stands', () => {
    const near = sun('a', 100, 100, 12, 90);
    const far = sun('b', 400, 100, 12, 90);
    const [offset] = solve([near, far], [station('b', 450, 100)], [], 'group').stations;
    expect(offset!.x).toBeGreaterThan(0);
    expect(apart(moved(station('b', 450, 100), offset!), { ...far, radius: far.reach })).toBeGreaterThanOrEqual(
      STAND_APART_GAP - CLOSE,
    );
  });

  describe('the group variant', () => {
    it('keeps a station out of the whole group of its system, where the sun-only rule leaves it', () => {
      const home = sun('a', 100, 100, 12, 90);
      const inside = station('a', 160, 100);
      const sunOnly = solve([home], [inside], [], 'sun').stations[0]!;
      const group = solve([home], [inside], [], 'group').stations[0]!;
      expect(sunOnly).toEqual({ x: 0, y: 0 });
      const placed = moved(inside, group);
      expect(apart(placed, { ...home, radius: home.reach })).toBeCloseTo(STAND_APART_GAP);
    });

    it('still clears every sun disc of the other systems', () => {
      const home = sun('a', 100, 100, 12, 90);
      const other = sun('b', 300, 100, 12, 90);
      const stand = station('a', 290, 100);
      const [offset] = solve([home, other], [stand], [], 'group').stations;
      expect(apart(moved(stand, offset!), other)).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    });
  });

  describe('the edge of the view', () => {
    const view = { width: 390, height: 844 };

    it('slides a station along the edge rather than over it, still clear of its system', () => {
      // A system by the left edge, its station below and to the left: the push would carry it off the screen.
      const home = sun('a', 50, 300, 12, 50);
      const stand = station('a', 30, 330, 14);
      const [offset] = standApart({ suns: [home], stations: [stand], dust: [], stationClears: 'group', view }).stations;
      const placed = moved(stand, offset!);
      expect(placed.x - placed.radius).toBeGreaterThanOrEqual(8 - 1e-9);
      expect(apart(placed, { ...home, radius: home.reach })).toBeGreaterThanOrEqual(STAND_APART_GAP - CLOSE);
    });

    it('never pulls in a station whose system is off the screen', () => {
      const home = sun('a', -200, 300, 12, 50);
      const stand = station('a', -240, 300, 14);
      const [offset] = standApart({ suns: [home], stations: [stand], dust: [], stationClears: 'group', view }).stations;
      expect(offset!.x).toBeLessThanOrEqual(0);
    });
  });
});
