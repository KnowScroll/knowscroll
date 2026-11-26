import type { SpaceStationDefinition } from '../space/space-definition';
import {
  blinkFrames,
  HOVER_AMPLITUDE,
  hoverFrames,
  phaseOf,
  pulseFrames,
  ringColours,
  SKY_STARS,
  skyAlpha,
  skyLights,
  STATION_MAX,
  STATION_MIN,
  stationLookOf,
  stationSize,
} from './station-look';

const station = (over: Partial<SpaceStationDefinition> = {}): SpaceStationDefinition => ({
  id: 'room-1',
  name: 'Room',
  systemId: 'system-1',
  position: { x: 0, y: 0.6, z: 0 },
  ...over,
});

describe('how big a station is drawn', () => {
  it('grows with its anchor, is never under the prototype’s 18 points and never over its 150', () => {
    expect(stationSize(0)).toBe(STATION_MIN);
    expect(stationSize(4)).toBe(STATION_MIN);
    expect(stationSize(1e6)).toBe(STATION_MAX);
    expect(stationSize(30)).toBeGreaterThan(stationSize(20));
    expect(stationSize(20)).toBeGreaterThan(stationSize(10));
  });
});

describe('the seven lights of a constellation', () => {
  it('are drawn for a station that carries a sky, lit as many as it says and the rest dark', () => {
    const lights = skyLights(70, 3);
    expect(lights).toHaveLength(SKY_STARS);
    expect(lights.filter((light) => light.lit)).toHaveLength(3);
    expect(skyLights(70, 0).filter((light) => light.lit)).toHaveLength(0);
    expect(skyLights(70, 7).every((light) => light.lit)).toBe(true);
  });

  it('are never drawn for a station with no sky, whatever its size (an outsider sees none)', () => {
    for (const width of [18, 34, 70, 150]) expect(skyLights(width, undefined)).toEqual([]);
  });

  it('appear as the station grows from 34 points to 70, and not before', () => {
    expect(skyLights(30, 7)).toEqual([]);
    expect(skyAlpha(34)).toBe(0);
    expect(skyAlpha(52)).toBeGreaterThan(0.3);
    expect(skyAlpha(52)).toBeLessThan(0.7);
    expect(skyAlpha(70)).toBe(1);
    expect(skyLights(40, 7)).toHaveLength(SKY_STARS);
  });

  it('stand round the station on a ring wider than it is tall, the first on its right', () => {
    const [first, ...rest] = skyLights(100, 7);
    expect(first).toMatchObject({ x: 125, y: 0 });
    for (const light of rest) expect(Math.abs(light.x / 125) ** 2 + Math.abs(light.y / 50) ** 2).toBeCloseTo(1, 6);
  });
});

describe('the ring', () => {
  it('is the prototype’s orange for a room with no face', () => {
    expect(ringColours(undefined)).toEqual({ far: '#B96A16', near: '#FFB347', shine: '#FFDFA0' });
  });

  it('wears the room’s accent, with a darker far half and a paler shine', () => {
    const ring = ringColours('mint');
    expect(ring.near).toBe('#14C79B');
    expect(ring.far).not.toBe(ring.near);
    expect(ring.shine).not.toBe(ring.near);
    const sum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(sum(ring.far)).toBeLessThan(sum(ring.near));
    expect(sum(ring.shine)).toBeGreaterThan(sum(ring.near));
  });

  it('lifts an accent too dark to be seen against the sky', () => {
    expect(ringColours('midnight').near).not.toBe('#040A17');
    expect(ringColours('soot').near).not.toBe('#111111');
  });
});

describe('what a station is drawn from', () => {
  it('is the room’s accent, its sky, what is live and whether it is calm', () => {
    const look = stationLookOf(
      station({
        emblem: {
          emblem: { frame: 'circle', glyph: 'ringed-planet' },
          palette: { ground: 'midnight', accent: 'sun', ink: 'cream' },
        },
        sky: { lit: 4, state: 'forming', finished: 0, constellationName: undefined },
        live: 'reel',
        calm: true,
      }),
    );
    expect(look).toMatchObject({ ring: ringColours('sun'), lit: 4, live: true, calm: true });
  });

  it('has no lit count for a station without a sky, is not live and not calm unless told', () => {
    expect(stationLookOf(station())).toMatchObject({ lit: undefined, live: false, calm: false });
  });

  it('gives each room a phase of its own, and the same one every time', () => {
    expect(phaseOf('a')).toBe(phaseOf('a'));
    expect(phaseOf('a')).not.toBe(phaseOf('b'));
    for (const id of ['a', 'b', 'c']) expect(phaseOf(id)).toBeGreaterThanOrEqual(0);
  });
});

describe('the clock keyframes', () => {
  const closes = (frames: { inputRange: readonly number[]; outputRange: readonly number[] }) => {
    expect(frames.inputRange[0]).toBe(0);
    expect(frames.inputRange[frames.inputRange.length - 1]).toBe(1);
    expect(frames.outputRange[0]).toBeCloseTo(frames.outputRange[frames.outputRange.length - 1]!, 9);
    expect(frames.inputRange.length).toBe(frames.outputRange.length);
    for (let at = 1; at < frames.inputRange.length; at += 1)
      expect(frames.inputRange[at]).toBeGreaterThan(frames.inputRange[at - 1]!);
  };

  it('loop without a jump', () => {
    for (const frames of [blinkFrames(0), blinkFrames(2.1), hoverFrames(4), pulseFrames()]) closes(frames);
  });

  it('blink: on for about 44 % of the period (the prototype’s threshold of 0.2), off the rest', () => {
    for (const phase of [0, 1, 2.5, 5]) {
      const { outputRange } = blinkFrames(phase);
      const samples = outputRange.slice(0, -1);
      const on = samples.filter((opacity) => opacity > 0.5).length / samples.length;
      expect(on).toBeGreaterThan(0.38);
      expect(on).toBeLessThan(0.5);
      for (const opacity of outputRange) {
        expect(opacity).toBeGreaterThanOrEqual(0);
        expect(opacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('hover: rises and sinks by 1.5 points, never more', () => {
    const { outputRange } = hoverFrames(1);
    expect(Math.max(...outputRange)).toBeGreaterThan(HOVER_AMPLITUDE * 0.95);
    expect(Math.min(...outputRange)).toBeLessThan(-HOVER_AMPLITUDE * 0.95);
    expect(Math.max(...outputRange.map(Math.abs))).toBeLessThanOrEqual(HOVER_AMPLITUDE);
  });

  it('pulse: the red light swells between 0.8 and 1.7 of its size', () => {
    const { outputRange } = pulseFrames();
    expect(Math.min(...outputRange)).toBeGreaterThanOrEqual(0.8 - 1e-9);
    expect(Math.max(...outputRange)).toBeLessThanOrEqual(1.7 + 1e-9);
  });
});
