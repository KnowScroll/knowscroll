import { fillLoops, maskLoops, strokeLoops, type PixelTarget, type Rgba } from './fill-loops';

const RED: Rgba = [255, 0, 0, 1];

const blank = (width: number, height: number): PixelTarget => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];
const pixel = (target: PixelTarget, column: number, row: number): number[] =>
  Array.from(target.data.slice((row * target.width + column) * 4, (row * target.width + column) * 4 + 4));
const painted = (target: PixelTarget): number =>
  target.data.reduce((count, value, at) => count + (at % 4 === 3 && value > 0 ? 1 : 0), 0);

describe('filling loops', () => {
  it('paints the pixels whose centres are inside a square, and nothing else', () => {
    const target = blank(10, 10);
    fillLoops(target, [square(2, 2, 8, 8)], RED);
    expect(painted(target)).toBe(36);
    expect(pixel(target, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(target, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(pixel(target, 8, 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(target, 1, 4)).toEqual([0, 0, 0, 0]);
  });

  it('leaves a hole where a loop lies inside another (even-odd)', () => {
    const target = blank(10, 10);
    fillLoops(target, [square(1, 1, 9, 9), square(3, 3, 7, 7)], RED);
    expect(painted(target)).toBe(64 - 16);
    expect(pixel(target, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(pixel(target, 2, 5)).toEqual([255, 0, 0, 255]);
  });

  it('scales world units to pixels', () => {
    const target = blank(20, 10);
    fillLoops(target, [square(1, 1, 3, 3)], RED, { scale: { x: 4, y: 2 } });
    // 2 units wide at 4 px and 2 units tall at 2 px: 8 by 4.
    expect(painted(target)).toBe(32);
    expect(pixel(target, 4, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(target, 11, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(target, 12, 5)).toEqual([0, 0, 0, 0]);
  });

  it('draws a loop over the seam at both edges', () => {
    const target = blank(10, 4);
    fillLoops(target, [square(8, 0, 12, 4)], RED, { wrapWidth: 10 });
    for (let row = 0; row < 4; row++) {
      expect(pixel(target, 8, row)[3]).toBe(255);
      expect(pixel(target, 9, row)[3]).toBe(255);
      expect(pixel(target, 0, row)[3]).toBe(255);
      expect(pixel(target, 1, row)[3]).toBe(255);
      expect(pixel(target, 2, row)[3]).toBe(0);
      expect(pixel(target, 7, row)[3]).toBe(0);
    }
  });

  it('lays a see-through colour once where a loop and its own wrapped copy overlap', () => {
    const target = blank(10, 2);
    fillLoops(target, [square(-1, 0, 11, 2)], [0, 0, 255, 0.5], { wrapWidth: 10 });
    expect(pixel(target, 5, 0)).toEqual([0, 0, 255, 128]);
  });

  it('adds up solid shapes in a union, where even-odd would cancel their overlap', () => {
    const shapes = [square(1, 1, 6, 6), square(4, 4, 9, 9)];
    const evenOdd = blank(10, 10);
    const union = blank(10, 10);
    fillLoops(evenOdd, shapes, RED);
    fillLoops(union, shapes, [255, 0, 0, 0.5], { union: true });
    expect(pixel(evenOdd, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(pixel(union, 5, 5)).toEqual([255, 0, 0, 128]);
    expect(painted(union)).toBe(25 + 25 - 4);
  });

  it('blends a see-through colour over what is already there', () => {
    const target = blank(4, 4);
    fillLoops(target, [square(0, 0, 4, 4)], [0, 0, 255, 1]);
    fillLoops(target, [square(0, 0, 4, 4)], [255, 0, 0, 0.5]);
    expect(pixel(target, 1, 1)).toEqual([128, 0, 128, 255]);
  });

  it('paints only inside a clip mask', () => {
    const target = blank(10, 10);
    const mask = maskLoops(target, [square(0, 0, 5, 10)]);
    fillLoops(target, [square(2, 2, 8, 8)], RED, { clip: mask });
    expect(pixel(target, 4, 4)[3]).toBe(255);
    expect(pixel(target, 5, 4)[3]).toBe(0);
  });

  it('makes a mask that is 1 exactly where a fill would paint', () => {
    const target = blank(10, 10);
    const mask = maskLoops(target, [square(1, 1, 9, 9), square(3, 3, 7, 7)]);
    expect(mask.reduce((sum, value) => sum + value, 0)).toBe(48);
    expect(mask[5 * 10 + 5]).toBe(0);
    expect(mask[2 * 10 + 2]).toBe(1);
  });
});

describe('stroking loops', () => {
  it('draws a line the width asked for along the edges and leaves the inside alone', () => {
    const target = blank(30, 30);
    strokeLoops(target, [square(5, 5, 25, 25)], RED, { width: 4 });
    expect(pixel(target, 15, 4)[3]).toBe(255);
    expect(pixel(target, 15, 6)[3]).toBe(255);
    expect(pixel(target, 15, 15)[3]).toBe(0);
    expect(pixel(target, 15, 1)[3]).toBe(0);
    expect(pixel(target, 3, 15)[3]).toBe(255);
  });

  it('draws a see-through line once where it crosses itself', () => {
    const target = blank(30, 30);
    strokeLoops(target, [square(5, 5, 25, 25)], [0, 0, 255, 0.5], { width: 4 });
    expect(pixel(target, 5, 5)).toEqual([0, 0, 255, 128]);
  });

  it('carries a line over the seam', () => {
    const target = blank(20, 20);
    strokeLoops(target, [square(18, 5, 24, 15)], RED, { width: 2, wrapWidth: 20 });
    expect(pixel(target, 18, 10)[3]).toBeGreaterThan(0);
    expect(pixel(target, 4, 10)[3]).toBeGreaterThan(0);
    expect(pixel(target, 10, 10)[3]).toBe(0);
  });
});
