import type { PictureBox, PictureScene, PictureShape, TextShape } from '../scene';
import { textWidth } from '../text';

/**
 * Checks the layout tests share: where a shape lies and whether a scene keeps to its box. They measure shapes their own
 * way, tighter than the layouts do (a layout reserves room for bold text and a safety margin), so a layout that passes
 * has room to spare. Test support only; nothing in the app imports it.
 */

/** The boxes a picture is laid out for: a phone figure, a smaller phone, beside the text on a desktop, a cover. */
export const TEST_BOXES: readonly Omit<PictureBox, 'textScale'>[] = [
  { width: 320, height: 190 },
  { width: 390, height: 287 },
  { width: 560, height: 380 },
  { width: 360, height: 140 },
];

export const TEXT_SCALES: readonly number[] = [1, 2];

export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The space a text shape covers, from its first line's top to its last line's bottom. */
export function textBounds(shape: TextShape): Bounds {
  const width = Math.max(...shape.lines.map((line) => textWidth(line, shape.size)));
  const left = shape.anchor === 'start' ? shape.x : shape.anchor === 'end' ? shape.x - width : shape.x - width / 2;
  return {
    left,
    right: left + width,
    top: shape.y - shape.size * 0.8,
    bottom: shape.y + (shape.lines.length - 1) * shape.lineHeight + shape.size * 0.2,
  };
}

const around = (points: readonly { x: number; y: number }[], reach: number): Bounds => ({
  left: Math.min(...points.map((point) => point.x)) - reach,
  right: Math.max(...points.map((point) => point.x)) + reach,
  top: Math.min(...points.map((point) => point.y)) - reach,
  bottom: Math.max(...points.map((point) => point.y)) + reach,
});

/** The space a shape covers, including half its stroke; an arc is measured along its length. */
export function shapeBounds(shape: PictureShape): Bounds {
  switch (shape.type) {
    case 'rect': {
      const half = shape.strokeWidth / 2;
      return {
        left: shape.x - half,
        right: shape.x + shape.width + half,
        top: shape.y - half,
        bottom: shape.y + shape.height + half,
      };
    }
    case 'circle': {
      const reach = shape.r + shape.strokeWidth / 2;
      return { left: shape.cx - reach, right: shape.cx + reach, top: shape.cy - reach, bottom: shape.cy + reach };
    }
    case 'line':
      return around(
        [
          { x: shape.x1, y: shape.y1 },
          { x: shape.x2, y: shape.y2 },
        ],
        shape.strokeWidth / 2,
      );
    case 'arc': {
      const steps = 24;
      const points = Array.from({ length: steps + 1 }, (_, index) => {
        const angle = shape.from + ((shape.to - shape.from) * index) / steps;
        return { x: shape.cx + shape.r * Math.cos(angle), y: shape.cy + shape.r * Math.sin(angle) };
      });
      return around(points, shape.strokeWidth / 2);
    }
    case 'text':
      return textBounds(shape);
  }
}

const EDGE_SLACK = 0.5;

/** Every shape of the scene that lies outside its box. */
export function shapesOutside(scene: PictureScene): string[] {
  return scene.shapes
    .filter((shape) => {
      const bounds = shapeBounds(shape);
      return (
        bounds.left < -EDGE_SLACK ||
        bounds.top < -EDGE_SLACK ||
        bounds.right > scene.width + EDGE_SLACK ||
        bounds.bottom > scene.height + EDGE_SLACK
      );
    })
    .map((shape) => shape.key);
}

export const boundsOverlap = (a: Bounds, b: Bounds): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** The pairs of text shapes of the scene whose bounds overlap, as "key / key". */
export function overlappingTexts(scene: PictureScene): string[] {
  const texts = scene.shapes.filter((shape): shape is TextShape => shape.type === 'text');
  return texts.flatMap((first, index) =>
    texts
      .slice(index + 1)
      .filter((second) => boundsOverlap(textBounds(first), textBounds(second)))
      .map((second) => `${first.key} / ${second.key}`),
  );
}

/** The keys of a scene, in order. */
export const keysOf = (scene: PictureScene): string[] => scene.shapes.map((shape) => shape.key);

export const hasUniqueKeys = (scene: PictureScene): boolean => new Set(keysOf(scene)).size === scene.shapes.length;

/** The distance from a point to the nearest point of a bounds (0 inside it). */
export function distanceFromPoint(bounds: Bounds, x: number, y: number): number {
  return Math.hypot(Math.max(bounds.left - x, 0, x - bounds.right), Math.max(bounds.top - y, 0, y - bounds.bottom));
}
