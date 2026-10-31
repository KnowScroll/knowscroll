/**
 * The light of a hot surface (D-195): where its glow is strongest and what colour that makes. Shared by
 * the kits that draw a star or a glowing disc. Everything is derived from physical constants; no colour
 * is typed in by hand.
 */

const PLANCK = 6.62607015e-34;
const LIGHT_SPEED = 299_792_458;
const BOLTZMANN = 1.380649e-23;

/** Wien's displacement constant in nanometre kelvins: the wavelength of strongest glow is this over the temperature. */
export const WIEN_NANOMETRE_KELVINS = 2_897_771.955;

/** The wavelength, in nanometres, where a surface at `kelvin` glows most strongly per unit wavelength (Wien's law). */
export function peakNanometres(kelvin: number): number {
  return WIEN_NANOMETRE_KELVINS / kelvin;
}

/** Planck's law: the glow of a surface at `kelvin` at one wavelength, in arbitrary units. */
export function planckGlow(nanometres: number, kelvin: number): number {
  const metres = nanometres * 1e-9;
  return 1 / (metres ** 5 * (Math.exp((PLANCK * LIGHT_SPEED) / (metres * BOLTZMANN * kelvin)) - 1));
}

/** One lobe of the analytic fit to the CIE 1931 colour-matching functions (Wyman, Sloan and Shirley, 2013). */
function lobe(nanometres: number, centre: number, widthBelow: number, widthAbove: number): number {
  const offset = (nanometres - centre) / (nanometres < centre ? widthBelow : widthAbove);
  return Math.exp(-0.5 * offset * offset);
}

/** How the average eye answers to light of one wavelength: the CIE 1931 X, Y and Z, by the analytic fit. */
export function colourMatching(nanometres: number): readonly [number, number, number] {
  return [
    1.056 * lobe(nanometres, 599.8, 37.9, 31.0) +
      0.362 * lobe(nanometres, 442.0, 16.0, 26.7) -
      0.065 * lobe(nanometres, 501.1, 20.4, 26.2),
    0.821 * lobe(nanometres, 568.8, 46.9, 40.5) + 0.286 * lobe(nanometres, 530.9, 16.3, 31.1),
    1.217 * lobe(nanometres, 437.0, 11.8, 36.0) + 0.681 * lobe(nanometres, 459.0, 26.0, 13.8),
  ];
}

/** The linear sRGB of a colour in CIE XYZ, with channels the screen cannot show set to zero, scaled so that the largest is 1. */
export function linearRgbOf(x: number, y: number, z: number): readonly [number, number, number] {
  const red = Math.max(0, 3.2406 * x - 1.5372 * y - 0.4986 * z);
  const green = Math.max(0, -0.9689 * x + 1.8758 * y + 0.0415 * z);
  const blue = Math.max(0, 0.0557 * x - 0.204 * y + 1.057 * z);
  const largest = Math.max(red, green, blue, Number.MIN_VALUE);
  return [red / largest, green / largest, blue / largest];
}

const encode = (linear: number): number => (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);
const hexOf = (linear: readonly number[]): string =>
  `#${linear
    .map((channel) =>
      Math.round(255 * encode(channel))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** The colour, as linear sRGB scaled to a largest channel of 1, that a surface at `kelvin` looks: the glow of every wavelength weighed by the eye. */
export function blackbodyLinearRgb(kelvin: number): readonly [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let nanometres = 360; nanometres <= 830; nanometres += 5) {
    const glow = planckGlow(nanometres, kelvin);
    const [matchX, matchY, matchZ] = colourMatching(nanometres);
    x += glow * matchX;
    y += glow * matchY;
    z += glow * matchZ;
  }
  return linearRgbOf(x, y, z);
}

/** The colour a surface at `kelvin` looks, as a hex string. */
export function blackbodyColour(kelvin: number): string {
  return hexOf(blackbodyLinearRgb(kelvin));
}

/**
 * The colour of light of a single visible wavelength, as a hex string. A rough match: some spectral colours
 * lie outside what a screen can show, and the analytic fit is poor at the far ends, so the ends keep the
 * colour of 420 nm (violet) and 650 nm (red).
 */
export function wavelengthColour(nanometres: number): string {
  const [x, y, z] = colourMatching(Math.min(650, Math.max(420, nanometres)));
  return hexOf(linearRgbOf(x, y, z));
}

/** The visible range, in nanometres, that the pictures paint in colour; light outside it is ultraviolet or infrared. */
export const VISIBLE_NANOMETRES = { from: 380, to: 750 } as const;
