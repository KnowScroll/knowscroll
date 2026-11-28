import {
  bendFade,
  EINSTEIN_SHARE,
  sourceOf,
  strongestLenses,
  wantedMasses,
  type Lens,
  type LensMass,
  type LensTarget,
} from './sky-lens';

const system = (id: string, x: number, radiusPx = 60): LensMass => ({
  id,
  kind: 'system',
  systemId: id,
  x,
  y: 300,
  radiusPx,
});
const planet = (id: string, systemId: string, x: number, radiusPx = 12): LensMass => ({
  id,
  kind: 'planet',
  systemId,
  x,
  y: 300,
  radiusPx,
});
const at = (stop: LensTarget['stop'], systemId: string | null = null, planetId: string | null = null): LensTarget => ({
  stop,
  systemId,
  planetId,
});
const MASSES = [system('a', 100), system('b', 300), planet('a.1', 'a', 120), planet('b.1', 'b', 320)];

describe('which masses bend the sky', () => {
  it('rings every system at the whole universe, and no planet beside its sun', () => {
    expect([...wantedMasses(at('universe'), MASSES).keys()]).toEqual(['a', 'b']);
  });

  it('bends only the system the camera is at, at a star', () => {
    expect([...wantedMasses(at('star', 'a'), MASSES).keys()]).toEqual(['a']);
  });

  it('bends only the planet the camera is at, alone, at a planet stop: not its star', () => {
    expect([...wantedMasses(at('planet', 'a', 'a.1'), MASSES).keys()]).toEqual(['a.1']);
  });

  it('bends nothing on the ground', () => {
    expect(wantedMasses(at('ground', 'a', 'a.1'), MASSES).size).toBe(0);
  });

  it('skips a mass too small to see', () => {
    expect(wantedMasses(at('universe'), [system('far', 100, 1)]).size).toBe(0);
  });
});

describe('the lenses drawn', () => {
  it('give each lens an Einstein radius of its group radius times the share and its weight', () => {
    const [lens] = strongestLenses([system('a', 100, 50)], new Map([['a', 0.5]]), 6);
    expect(lens).toEqual({ x: 100, y: 300, radius: 50, einstein: EINSTEIN_SHARE * 50 * 0.5 });
  });

  it('drop a mass whose weight has eased to nothing, and keep the widest when there are too many', () => {
    const masses = [system('a', 0, 20), system('b', 0, 80), system('c', 0, 50), system('gone', 0, 90)];
    const weights = new Map([
      ['a', 1],
      ['b', 1],
      ['c', 1],
    ]);
    expect(strongestLenses(masses, weights, 2).map((lens) => lens.radius)).toEqual([80, 50]);
  });
});

const lens: Lens = { x: 200, y: 400, radius: 100, einstein: EINSTEIN_SHARE * 100 };
const offset = (distance: number, angle = 0.4) => ({
  x: lens.x + Math.cos(angle) * distance,
  y: lens.y + Math.sin(angle) * distance,
});
const from = (point: { x: number; y: number }) => Math.hypot(point.x - lens.x, point.y - lens.y);

describe('the bend of one lens (the shader’s maths)', () => {
  it('is the identity with no lens, and with a lens whose Einstein radius is 0', () => {
    expect(sourceOf({ x: 12, y: 34 }, [])).toEqual({ x: 12, y: 34 });
    expect(sourceOf({ x: 12, y: 34 }, [{ ...lens, einstein: 0 }])).toEqual({ x: 12, y: 34 });
  });

  it('is an even zoom inside the group: the sky is read nearer the centre by a fixed share', () => {
    const share = 1 - EINSTEIN_SHARE * EINSTEIN_SHARE;
    for (const distance of [5, 40, 99]) {
      expect(from(sourceOf(offset(distance), [lens]))).toBeCloseTo(distance * share, 6);
    }
  });

  it('is continuous at the group’s rim', () => {
    const inside = from(sourceOf(offset(99.99999), [lens]));
    const outside = from(sourceOf(offset(100.00001), [lens]));
    expect(Math.abs(outside - inside)).toBeLessThan(1e-4);
  });

  it('mirrors nothing: every pixel reads the sky on its own side of the centre, in the same direction', () => {
    for (const distance of [0.5, 10, 70, 100, 130, 250, 450, 700]) {
      const source = sourceOf(offset(distance), [lens]);
      expect(from(source)).toBeGreaterThan(0);
      const along = (source.x - lens.x) * Math.cos(0.4) + (source.y - lens.y) * Math.sin(0.4);
      expect(along).toBeGreaterThan(0);
    }
  });

  it('stretches the sky round the mass outside the group: tangentially more than radially, so a star becomes an arc', () => {
    const distance = 150;
    const radialStep = 0.01;
    const here = from(sourceOf(offset(distance), [lens]));
    const nearer = from(sourceOf(offset(distance + radialStep), [lens]));
    const radial = (nearer - here) / radialStep;
    const tangential = here / distance;
    expect(tangential).toBeLessThan(1);
    expect(radial).toBeGreaterThan(tangential);
    // The sky at that spot is magnified round the circle by 1 / tangential (about 1.6 at a rim and a half, 5 at the rim).
    expect(1 / tangential).toBeGreaterThan(1.5);
  });

  it('fades to nothing between three and six radii, so a lens never covers the screen', () => {
    expect(bendFade(300, 100)).toBe(1);
    expect(bendFade(600, 100)).toBe(0);
    expect(bendFade(450, 100)).toBeCloseTo(0.5, 6);
    expect(sourceOf(offset(650), [lens])).toEqual(offset(650));
  });

  it('adds the shifts of several lenses', () => {
    const other: Lens = { x: 330, y: 380, radius: 60, einstein: EINSTEIN_SHARE * 60 };
    const point = { x: 260, y: 520 };
    const both = sourceOf(point, [lens, other]);
    const first = sourceOf(point, [lens]);
    const second = sourceOf(point, [other]);
    expect(both.x - point.x).toBeCloseTo(first.x - point.x + (second.x - point.x), 9);
    expect(both.y - point.y).toBeCloseTo(first.y - point.y + (second.y - point.y), 9);
  });
});
