import { describe, expect, it } from 'vitest';
import {
  blackbodyColour,
  blackbodyLinearRgb,
  colourMatching,
  peakNanometres,
  planckGlow,
  wavelengthColour,
} from './spectrum.js';

/** The wavelength of the tallest point of Planck's curve, found by looking at every half nanometre: a way that does not use Wien's law. */
function tallestPoint(kelvins: number): number {
  let best = 20;
  for (let nanometres = 20; nanometres <= 4000; nanometres += 0.5)
    if (planckGlow(nanometres, kelvins) > planckGlow(best, kelvins)) best = nanometres;
  return best;
}

const channels = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

describe('the light of a hot surface against first principles', () => {
  it.each([2800, 3500, 5772, 10000, 30000])('glows most strongly where Wien’s law says, at %s K', (kelvins) => {
    expect(Math.abs(tallestPoint(kelvins) - peakNanometres(kelvins))).toBeLessThan(1);
  });

  it('shifts the strongest glow to shorter wavelengths the hotter the surface', () => {
    const peaks = [3000, 4000, 6000, 12000, 24000].map(peakNanometres);
    expect(peaks).toEqual([...peaks].sort((first, second) => second - first));
  });

  it('looks white at 6500 K, the daylight white point', () => {
    const [red = 0, green = 0, blue = 0] = blackbodyLinearRgb(6504);
    expect(Math.max(red, green, blue)).toBe(1);
    expect(Math.min(red, green, blue)).toBeGreaterThan(0.93);
  });

  it('makes a cooler surface redder and a hotter surface bluer, steadily over the whole range of stars', () => {
    const ratios = [2500, 3000, 3500, 4000, 5000, 6000, 8000, 10000, 15000, 25000].map((kelvins) => {
      const [red = 1, , blue = 0] = blackbodyLinearRgb(kelvins);
      return blue / red;
    });
    for (let index = 1; index < ratios.length; index += 1)
      expect(ratios[index] ?? 0, String(index)).toBeGreaterThan(ratios[index - 1] ?? 0);
    const [coolRed = 0, , coolBlue = 0] = blackbodyLinearRgb(3500);
    const [hotRed = 0, , hotBlue = 0] = blackbodyLinearRgb(15000);
    expect(coolRed).toBeGreaterThan(coolBlue);
    expect(hotBlue).toBeGreaterThan(hotRed);
  });

  it('gives the colours that published tables of blackbody colours give, to within a few steps of 255', () => {
    const near = (hex: string, expected: readonly number[]) =>
      channels(hex).forEach((channel, index) => expect(Math.abs(channel - (expected[index] ?? 0))).toBeLessThan(12));
    near(blackbodyColour(3500), [255, 196, 137]);
    near(blackbodyColour(5000), [255, 228, 206]);
    near(blackbodyColour(10000), [202, 218, 255]);
  });

  it('has the colour-matching functions the fit promises: the eye answers most to green-yellow light', () => {
    expect(colourMatching(555)[1]).toBeGreaterThan(0.97);
    expect(colourMatching(555)[1]).toBeLessThan(1.03);
    expect(colourMatching(445)[2]).toBeGreaterThan(1.5);
  });

  it('paints a single wavelength by its colour: blue, green, red', () => {
    const [blueRed = 0, , blueBlue = 0] = channels(wavelengthColour(450));
    const [, greenGreen = 0] = channels(wavelengthColour(530));
    const [redRed = 0, , redBlue = 0] = channels(wavelengthColour(640));
    expect(blueBlue).toBeGreaterThan(blueRed);
    expect(greenGreen).toBeGreaterThan(200);
    expect(redRed).toBeGreaterThan(redBlue);
  });
});
