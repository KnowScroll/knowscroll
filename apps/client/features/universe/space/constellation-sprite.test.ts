import { CONSTELLATION_POINTS } from '@knowscroll/client-core';
import { constellationImage, rasterConstellation, starColour } from './scene/constellation-sprite';

const opaqueColours = (data: Uint8Array): Set<number> => {
  const colours = new Set<number>();
  for (let at = 0; at < data.length; at += 4)
    if (data[at + 3]! > 200) colours.add((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!);
  return colours;
};
const covered = (data: Uint8Array): number => {
  let count = 0;
  for (let at = 3; at < data.length; at += 4) if (data[at]! > 0) count += 1;
  return count;
};
const alphaAt = ({ data, width }: { data: Uint8Array; width: number }, x: number, y: number): number =>
  data[(Math.floor(y * width) * width + Math.floor(x * width)) * 4 + 3]!;

describe('the constellation a station wears', () => {
  it('draws a lit star as a flat disc at its point, and a star not earned yet as a hollow ring', () => {
    const image = rasterConstellation(2, 'sun');
    expect(alphaAt(image, CONSTELLATION_POINTS[0]![0], CONSTELLATION_POINTS[0]![1])).toBe(255);
    // The fourth star is not earned: its centre is empty and its ring is not.
    const [x, y] = CONSTELLATION_POINTS[3]!;
    expect(alphaAt(image, x, y)).toBe(0);
    expect(alphaAt(image, x + 0.03, y)).toBeGreaterThan(0);
  });

  it('joins neighbouring lit stars with a line, and more stars cover more', () => {
    const none = covered(rasterConstellation(0, 'sun').data);
    const two = covered(rasterConstellation(2, 'sun').data);
    const seven = covered(rasterConstellation(7, 'sun').data);
    expect(two).toBeGreaterThan(none);
    // Midway between stars one and two there is a line, but only once both are lit.
    const [ax, ay] = CONSTELLATION_POINTS[0]!;
    const [bx, by] = CONSTELLATION_POINTS[1]!;
    expect(alphaAt(rasterConstellation(2, 'sun'), (ax + bx) / 2, (ay + by) / 2)).toBeGreaterThan(0);
    expect(alphaAt(rasterConstellation(1, 'sun'), (ax + bx) / 2, (ay + by) / 2)).toBe(0);
    expect(seven).toBeGreaterThan(two);
  });

  it('uses only the room’s accent for what is earned, and no glow: every opaque pixel is that colour', () => {
    const colours = opaqueColours(rasterConstellation(7, 'coral').data);
    expect([...colours]).toEqual([0xd9442b]);
  });

  it('falls back to yellow for a room with no face, and to cream when the accent is too dark to see on the map', () => {
    expect(starColour(undefined)).toEqual([255, 228, 77]);
    expect(starColour('midnight')).toEqual([255, 251, 240]);
    expect(starColour('sun')).toEqual([255, 228, 77]);
  });

  it('is the same picture every time, and a texture is its copy turned over', () => {
    expect(rasterConstellation(4, 'mint')).toBe(rasterConstellation(4, 'mint'));
    const upright = rasterConstellation(4, 'mint');
    const turned = constellationImage(4, 'mint');
    const stride = upright.width * 4;
    expect([...turned.data.subarray(0, stride)]).toEqual([
      ...upright.data.subarray((upright.height - 1) * stride, upright.height * stride),
    ]);
  });
});
