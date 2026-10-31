import { kitDefinition, ZONE_STARS, type StarlightState } from '@knowscroll/scroll-model';
import {
  canTweenStarlight,
  chartX,
  chartY,
  FRAME,
  HOTTEST_FIRST,
  lerpStarlightScene,
  starlightSceneOf,
  strengthenColour,
  stripX,
  zoneX,
} from './starlight-scene';

const state = (patch: Partial<StarlightState>): StarlightState =>
  kitDefinition('starlight.v1').settle({
    view: 'colour',
    star: 'sun-like',
    distance: 'near',
    orbit: 'none',
    focus: 'none',
    ...patch,
  }) as StarlightState;

const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);

describe('the starlight picture agrees with the physics', () => {
  it('draws the hotter star bluer and its strongest glow farther left on the strip, after the colours are strengthened', () => {
    const scene = starlightSceneOf(state({}));
    expect(scene.kinds).toEqual(HOTTEST_FIRST);
    for (let index = 1; index < scene.colours.length; index += 1) {
      const hotter = scene.colours[index - 1] ?? '#000000';
      const cooler = scene.colours[index] ?? '#000000';
      expect(channel(hotter, 5) - channel(hotter, 1)).toBeGreaterThanOrEqual(channel(cooler, 5) - channel(cooler, 1));
      expect(scene.peakX[index - 1] ?? 0).toBeLessThan(scene.peakX[index] ?? 0);
    }
    expect(stripX(150)).toBe(20);
    expect(stripX(850)).toBe(300);
  });

  it('keeps each star’s hue when it strengthens the colour: a cool star stays red-orange, the Sun near white, a hot star blue', () => {
    const drawn = (kind: (typeof HOTTEST_FIRST)[number]) => {
      const hex = starlightSceneOf(state({})).colours[HOTTEST_FIRST.indexOf(kind)] ?? '#000000';
      return { red: channel(hex, 1), green: channel(hex, 3), blue: channel(hex, 5) };
    };
    const giant = drawn('giant');
    expect(giant.red).toBe(255);
    expect(giant.green).toBeLessThan(0.65 * giant.red);
    expect(giant.green).toBeGreaterThan(0.4 * giant.red);
    expect(giant.blue).toBeLessThan(0.35 * giant.red);
    const lowMass = drawn('low-mass');
    expect(lowMass.green).toBeLessThan(0.7 * lowMass.red);
    const sun = drawn('sun-like');
    expect(Math.min(sun.red, sun.green, sun.blue)).toBeGreaterThanOrEqual(0.75 * 255);
    const dwarf = drawn('white-dwarf');
    expect(dwarf.blue).toBe(255);
    expect(dwarf.red).toBeLessThan(0.4 * dwarf.blue);
    expect(strengthenColour('#ffd4a6')).toBe('#ff9346');
  });

  it('places the stars on the chart where their temperature and output say: hotter to the left, giants above the band, white dwarfs below', () => {
    const scene = starlightSceneOf(state({ view: 'diagram' }));
    const bandAt = (x: number): number => {
      for (let index = 1; index < scene.bandX.length; index += 1) {
        const left = scene.bandX[index - 1] ?? 0;
        const right = scene.bandX[index] ?? 0;
        if (x >= Math.min(left, right) && x <= Math.max(left, right)) {
          const share = (x - left) / (right - left);
          return (scene.bandY[index - 1] ?? 0) + share * ((scene.bandY[index] ?? 0) - (scene.bandY[index - 1] ?? 0));
        }
      }
      return Number.NaN;
    };
    const place = (kind: (typeof HOTTEST_FIRST)[number]) => {
      const index = HOTTEST_FIRST.indexOf(kind);
      return { x: scene.pointX[index] ?? 0, y: scene.pointY[index] ?? 0 };
    };
    for (const kind of ZONE_STARS) expect(Math.abs(place(kind).y - bandAt(place(kind).x))).toBeLessThan(3);
    expect(place('giant').y).toBeLessThan(bandAt(place('giant').x) - 20);
    expect(place('white-dwarf').y).toBeGreaterThan(bandAt(place('white-dwarf').x) + 20);
    expect(chartX(10000)).toBeLessThan(chartX(5000));
    expect(chartY(100)).toBeLessThan(chartY(1));
    expect(scene.markedIndex).toBe(HOTTEST_FIRST.indexOf('sun-like'));
  });

  it('makes a frame at four steps sixteen cells, so one cell catches a sixteenth, as the share says', () => {
    for (const distance of ['near', 'middle', 'far'] as const) {
      const scene = starlightSceneOf(state({ view: 'dimming', distance }));
      const side = scene.steps * FRAME.cell;
      expect(FRAME.cell ** 2 / side ** 2).toBeCloseTo(scene.share, 12);
    }
    expect(starlightSceneOf(state({ view: 'dimming', distance: 'far' })).markedFrame).toBe(2);
  });

  it('draws the bars of the output view from the star’s size and heat, and the total as their sum', () => {
    for (const star of ['low-mass', 'giant', 'white-dwarf', 'bright'] as const) {
      const scene = starlightSceneOf(state({ view: 'output', star }));
      expect(scene.sizeDex + scene.heatDex).toBeCloseTo(scene.outputDex, 12);
    }
    expect(starlightSceneOf(state({ view: 'output', star: 'giant' })).markedRadiusPx).toBeGreaterThan(
      starlightSceneOf(state({ view: 'output', star: 'giant' })).referenceRadiusPx,
    );
    expect(starlightSceneOf(state({ view: 'output', star: 'white-dwarf' })).markedRadiusPx).toBeLessThan(
      starlightSceneOf(state({ view: 'output', star: 'white-dwarf' })).referenceRadiusPx,
    );
  });

  it('puts the planet inside a zone’s band exactly where the verdict says it is in the zone, and outside it otherwise', () => {
    for (const orbit of ['inner', 'earth', 'outer'] as const) {
      const scene = starlightSceneOf(state({ view: 'zone', orbit }));
      expect(scene.planetX).toBe(zoneX({ inner: 0.4, earth: 1, outer: 4 }[orbit]));
      ZONE_STARS.forEach((_, row) => {
        const inside = scene.planetX >= (scene.zoneInnerX[row] ?? 0) && scene.planetX <= (scene.zoneOuterX[row] ?? 0);
        const verdict = scene.verdicts[row];
        expect(inside).toBe(verdict === 'in-zone');
        if (verdict === 'too-hot') expect(scene.planetX).toBeLessThan(scene.zoneInnerX[row] ?? 0);
        if (verdict === 'too-cold') expect(scene.planetX).toBeGreaterThan(scene.zoneOuterX[row] ?? 0);
      });
    }
    expect(starlightSceneOf(state({ view: 'zone', orbit: 'none' })).planetX).toBe(-1);
  });

  it('draws a brighter star’s zone farther out and wider on the straight scale, and a cooler star’s closer in and narrower', () => {
    const scene = starlightSceneOf(state({ view: 'zone' }));
    const width = (row: number) => (scene.zoneOuterX[row] ?? 0) - (scene.zoneInnerX[row] ?? 0);
    expect(scene.zoneInnerX[0] ?? 0).toBeLessThan(scene.zoneInnerX[1] ?? 0);
    expect(scene.zoneInnerX[1] ?? 0).toBeLessThan(scene.zoneInnerX[2] ?? 0);
    expect(width(0)).toBeLessThan(width(1));
    expect(width(1)).toBeLessThan(width(2));
    expect(scene.zoneRow).toBe(1);
  });

  it('moves inside one view and fades between views', () => {
    const near = starlightSceneOf(state({ view: 'dimming', distance: 'near' }));
    const far = starlightSceneOf(state({ view: 'dimming', distance: 'far' }));
    expect(canTweenStarlight(near, far)).toBe(true);
    expect(canTweenStarlight(near, starlightSceneOf(state({ view: 'zone' })))).toBe(false);
    expect(lerpStarlightScene(near, far, 0.5).share).toBeCloseTo((near.share + far.share) / 2, 9);
  });
});
