/**
 * Turns a `#rrggbb` colour round the hue wheel by whole degrees, keeping its lightness and
 * saturation. A repeated planet type gets its own hue this way (D-103). Plain arithmetic, no trigonometry.
 */
export function turnHue(hex: string, degrees: number): string {
  if (degrees === 0 || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const [red, green, blue] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const lightness = (high + low) / 2;
  if (high === low) return hex;
  const spread = high - low;
  const saturation = lightness > 0.5 ? spread / (2 - high - low) : spread / (high + low);
  let hue: number;
  if (high === red) hue = (green - blue) / spread + (green < blue ? 6 : 0);
  else if (high === green) hue = (blue - red) / spread + 2;
  else hue = (red - green) / spread + 4;
  const turned = (((hue * 60 + degrees) % 360) + 360) % 360;
  const upper = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
  const lower = 2 * lightness - upper;
  const channel = (offset: number): string => {
    let t = (turned + offset) / 360;
    t -= Math.floor(t);
    const value =
      t < 1 / 6
        ? lower + (upper - lower) * 6 * t
        : t < 1 / 2
          ? upper
          : t < 2 / 3
            ? lower + (upper - lower) * (2 / 3 - t) * 6
            : lower;
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(120)}${channel(0)}${channel(-120)}`;
}
