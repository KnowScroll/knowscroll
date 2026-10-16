import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CosmosBackground } from '../../src/components/CosmosBackground.tsx';
import { farStarField } from '../../src/cosmos/farStars.ts';

interface Drawn {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  fill: string;
}

/** A 2D context that records every star CosmosBackground draws: where, how big, how bright, what colour. */
function recordingContext(drawn: Drawn[]) {
  let pending: Omit<Drawn, 'alpha' | 'fill'> | null = null;
  return {
    globalAlpha: 1,
    fillStyle: '' as unknown,
    setTransform() {},
    clearRect() {},
    fillRect() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    beginPath() {
      pending = null;
    },
    arc(x: number, y: number, radius: number) {
      pending = { x, y, radius };
    },
    fill() {
      if (pending) drawn.push({ ...pending, alpha: this.globalAlpha, fill: String(this.fillStyle) });
      pending = null;
    },
  };
}

function drawBackground(width: number, height: number, parallax: boolean): Drawn[] {
  const drawn: Drawn[] = [];
  const context = recordingContext(drawn);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  render(parallax ? <CosmosBackground camera={{ x: 0, y: 0, zoom: 1 }} /> : <CosmosBackground />);
  return drawn;
}

const rgb = (hex: string) => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('far star field', () => {
  it('reproduces the Universe background point for point (no parallax)', () => {
    const drawn = drawBackground(1000, 700, false);
    const field = farStarField(1000, 700, false);
    expect(drawn).toHaveLength(140);
    expect(field).toHaveLength(140);
    field.forEach((star, i) => {
      const seen = drawn[i]!;
      expect(star.x).toBeCloseTo(seen.x, 9);
      expect(star.y).toBeCloseTo(seen.y, 9);
      expect(star.radius).toBeCloseTo(seen.radius, 9);
      expect(star.alpha).toBe(seen.alpha);
      star.color.forEach((channel, c) => expect(channel).toBeCloseTo(rgb(seen.fill)[c]!, 9));
    });
  });

  it('reproduces the parallax canvas (140% of the screen, offset by -20%) in screen coordinates', () => {
    // The parallax canvas measures 140% of a 1000×700 screen and sits 20% up and left of it.
    const drawn = drawBackground(1400, 980, true);
    const field = farStarField(1000, 700, true);
    expect(drawn).toHaveLength(field.length);
    field.forEach((star, i) => {
      const seen = drawn[i]!;
      expect(star.x).toBeCloseTo(seen.x - 200, 6);
      expect(star.y).toBeCloseTo(seen.y - 140, 6);
      expect(star.radius).toBeCloseTo(seen.radius, 9);
      expect(star.alpha).toBe(seen.alpha);
    });
  });

  it('is seeded: the same screen always gives the same sky, and only the size scales it', () => {
    expect(farStarField(800, 600)).toEqual(farStarField(800, 600));
    const small = farStarField(500, 400, false);
    const large = farStarField(1000, 800, false);
    small.forEach((star, i) => {
      expect(large[i]!.x).toBeCloseTo(star.x * 2, 9);
      expect(large[i]!.y).toBeCloseTo(star.y * 2, 9);
      expect(large[i]!.radius).toBe(star.radius);
      expect(large[i]!.color).toEqual(star.color);
    });
  });
});
