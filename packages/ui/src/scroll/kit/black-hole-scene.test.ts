import { kitDefinition, type BlackHoleState } from '@knowscroll/scroll-model';
import {
  blackHoleSceneOf,
  canTweenBlackHole,
  chirpWave,
  DISC_PX,
  lerpBlackHoleScene,
  ORBIT_ARROW_PX,
  PULL,
  WAVES,
} from './black-hole-scene';

const state = (patch: Partial<BlackHoleState>): BlackHoleState =>
  kitDefinition('black-hole.v1').settle({
    view: 'formation',
    star: 'massive',
    stage: 'fusing',
    hole: 'small',
    merger: 'apart',
    focus: 'none',
    ...patch,
  }) as BlackHoleState;
const scene = (patch: Partial<BlackHoleState>) => blackHoleSceneOf(state(patch));
const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);

describe('the black-hole picture agrees with the physics', () => {
  it('draws the larger black hole’s horizon four times as wide as the smaller one’s, both to scale', () => {
    const horizon = scene({ view: 'horizon', hole: 'large' });
    expect(horizon.largeHolePx / horizon.smallHolePx).toBeCloseTo(4, 12);
    expect(horizon.largeMarked).toBe(1);
    expect(scene({ view: 'horizon', hole: 'small' }).largeMarked).toBe(0);
  });

  it('draws the shadow about two and a half times the horizon, and the horizon inside it', () => {
    const shadow = scene({ view: 'shadow' });
    expect(shadow.shadowPx / shadow.shadowHorizonPx).toBeCloseTo((3 * Math.sqrt(3)) / 2, 12);
    expect(shadow.shadowHorizonPx).toBeLessThan(shadow.shadowPx);
  });

  it('gives the star and the black hole of the same mass the same pull', () => {
    const pull = scene({ view: 'pull' });
    expect(PULL.starMassInSuns).toBe(PULL.holeMassInSuns);
    expect(pull.starPull).toBeCloseTo(pull.holePull, 12);
    expect(pull.starPull).toBeCloseTo(1, 12);
  });

  it('draws the hole of the disc a third of the way to its inner edge, and the gas hotter and bluer toward the middle', () => {
    const disc = scene({ view: 'disc' });
    expect(disc.diskHolePx * 3).toBeCloseTo(DISC_PX, 12);
    expect(disc.ringInnerPx[0]).toBe(DISC_PX);
    expect(disc.ringPx.slice(0, -1)).toEqual(disc.ringInnerPx.slice(1));
    const blueness = (hex: string | undefined) => channel(hex ?? '#000000', 5) - channel(hex ?? '#000000', 1);
    for (let index = 1; index < disc.ringColours.length; index += 1)
      expect(blueness(disc.ringColours[index - 1])).toBeGreaterThan(blueness(disc.ringColours[index]));
  });

  it('draws the nearer star faster, by the square root of the radius, on orbits twice and four times as wide', () => {
    const orbits = scene({ view: 'orbits' });
    expect(orbits.speedPx[0]).toBeCloseTo(ORBIT_ARROW_PX, 12);
    expect((orbits.speedPx[0] ?? 0) / (orbits.speedPx[1] ?? 1)).toBeCloseTo(Math.sqrt(2), 12);
    expect((orbits.speedPx[0] ?? 0) / (orbits.speedPx[2] ?? 1)).toBeCloseTo(2, 12);
    expect((orbits.orbitPx[1] ?? 0) / (orbits.orbitPx[0] ?? 1)).toBe(2);
    expect((orbits.orbitPx[2] ?? 0) / (orbits.orbitPx[0] ?? 1)).toBe(4);
  });

  it('draws a chirp that grows stronger and quicker until the merger and then dies away', () => {
    const wave = chirpWave();
    expect(wave).toHaveLength(WAVES.samples);
    const mergerAt = Math.round((wave.length - 1) / WAVES.ringdownEnd);
    const window = (from: number, to: number) => wave.slice(Math.floor(from * mergerAt), Math.floor(to * mergerAt));
    const strength = (samples: readonly number[]) => Math.max(...samples.map(Math.abs));
    const crossings = (samples: readonly number[]) =>
      samples.slice(1).filter((value, index) => Math.sign(value) !== Math.sign(samples[index] ?? 0)).length;
    expect(strength(window(0.0, 0.3))).toBeLessThan(strength(window(0.3, 0.7)));
    expect(strength(window(0.3, 0.7))).toBeLessThan(strength(window(0.7, 1)));
    expect(crossings(window(0.0, 0.3))).toBeLessThan(crossings(window(0.3, 0.7)));
    expect(crossings(window(0.3, 0.7))).toBeLessThan(crossings(window(0.7, 1)));
    expect(strength(wave.slice(-20))).toBeLessThan(0.1 * strength(window(0.9, 1)));
    expect(Math.max(...wave)).toBeLessThanOrEqual(1);
  });

  it('puts the two holes closer together as the merger nears, and one black hole after it', () => {
    const apart = scene({ view: 'waves', merger: 'apart' });
    const close = scene({ view: 'waves', merger: 'close' });
    const merged = scene({ view: 'waves', merger: 'merged' });
    expect(close.separationPx).toBeLessThan(apart.separationPx);
    expect(merged.merged).toBe(1);
    expect(apart.merged).toBe(0);
    expect(apart.nowShare).toBeLessThan(close.nowShare);
    expect(close.nowShare).toBeLessThan(merged.nowShare);
    expect(close.nowShare).toBeLessThan(close.mergerShare);
    expect(merged.nowShare).toBe(1);
  });

  it('collapses the core of the massive star at its fuel-out stage, and never the Sun’s kind of star', () => {
    expect(scene({ stage: 'fuel-out' }).pressure).toBeLessThan(scene({ stage: 'fuel-out' }).gravity);
    expect(scene({ stage: 'fusing' }).pressure).toBe(scene({ stage: 'fusing' }).gravity);
    expect(scene({ star: 'sun-like', stage: 'fuel-out' }).pressure).toBe(1);
    expect(scene({ star: 'sun-like', stage: 'fuel-out' }).massive).toBe(0);
    expect(scene({ stage: 'fuel-out' }).coreRadiusPx).toBeLessThan(scene({ stage: 'fusing' }).coreRadiusPx);
  });

  it('moves inside one view and fades between views', () => {
    const apart = scene({ view: 'waves', merger: 'apart' });
    const close = scene({ view: 'waves', merger: 'close' });
    expect(canTweenBlackHole(apart, close)).toBe(true);
    expect(canTweenBlackHole(apart, scene({ view: 'shadow' }))).toBe(false);
    expect(lerpBlackHoleScene(apart, close, 0.5).separationPx).toBeCloseTo(
      (apart.separationPx + close.separationPx) / 2,
      9,
    );
  });
});
