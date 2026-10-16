/**
 * The far sky the live Universe draws (`CosmosBackground`, seeded, decorative), reproduced point
 * for point so the opening's last frame lands on exactly the stars the reader then sees. The
 * Universe's background canvas is the parallax variant: 140% of the screen, offset by -20%.
 * The generator below must stay byte-for-byte the same expression as CosmosBackground's.
 */
export interface FarStar {
  x: number;
  y: number;
  radius: number;
  color: [number, number, number];
  alpha: number;
}

const PALETTE: [number, number, number][] = [
  [0xb7 / 255, 0xc3 / 255, 0xcc / 255],
  [0x8f / 255, 0xa3 / 255, 0xb0 / 255],
  [0xe9 / 255, 0xe3 / 255, 0xce / 255],
  [0x33 / 255, 0xc4 / 255, 0xb4 / 255],
];

export function farStarField(viewportWidth: number, viewportHeight: number, parallax = true): FarStar[] {
  const width = parallax ? viewportWidth * 1.4 : viewportWidth;
  const height = parallax ? viewportHeight * 1.4 : viewportHeight;
  const offsetX = parallax ? -viewportWidth * 0.2 : 0;
  const offsetY = parallax ? -viewportHeight * 0.2 : 0;
  let seed = 7317;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10000;
  };
  const stars: FarStar[] = [];
  for (let i = 0; i < 140; i++) {
    const x = next() * width;
    const y = next() * height;
    const bucket = Math.floor(next() * 10);
    const radius = bucket <= 6 ? 0.6 + next() * 0.4 : bucket <= 8 ? 1.0 + next() * 0.6 : 1.4 + next() * 0.8;
    const alpha = radius > 1.4 ? 0.95 : 0.7;
    const color = PALETTE[Math.floor(next() * PALETTE.length)] ?? PALETTE[0]!;
    stars.push({ x: x + offsetX, y: y + offsetY, radius, color, alpha });
  }
  return stars;
}
