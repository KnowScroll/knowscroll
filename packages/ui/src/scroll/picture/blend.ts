import { lerp } from '../kit/blend';
import type { PictureScene, PictureShape } from './scene';

/**
 * Two scenes are one picture changing when they draw the same picture in the same box: then a move between them is a
 * glide. A new picture, or the same picture in a new box, cross-fades instead.
 */
export function canGlidePictures(from: PictureScene, to: PictureScene): boolean {
  return from.pictureId === to.pictureId && from.width === to.width && from.height === to.height;
}

/** Every number of a shape that may move: positions, sizes and opacity. Words, roles and kinds never blend. */
const MOVING: { readonly [Type in PictureShape['type']]: readonly string[] } = {
  rect: ['x', 'y', 'width', 'height', 'cornerRadius', 'strokeWidth', 'opacity'],
  circle: ['cx', 'cy', 'r', 'strokeWidth', 'opacity'],
  line: ['x1', 'y1', 'x2', 'y2', 'strokeWidth', 'opacity'],
  arc: ['cx', 'cy', 'r', 'from', 'to', 'strokeWidth', 'opacity'],
  text: ['x', 'y', 'size', 'lineHeight', 'opacity'],
};

function blendShape(from: PictureShape, to: PictureShape, progress: number): PictureShape {
  if (from.type !== to.type) return progress < 0.5 ? from : to;
  const blended: Record<string, unknown> = { ...(progress < 0.5 ? from : to) };
  const before = from as unknown as Record<string, number>;
  const after = to as unknown as Record<string, number>;
  for (const key of MOVING[to.type]) blended[key] = lerp(before[key] ?? 0, after[key] ?? 0, progress);
  return blended as unknown as PictureShape;
}

/**
 * The scene `progress` (0..1) of the way between two scenes of one picture. A shape in both (by key) moves; one only in
 * the first fades out where it stood, one only in the second fades in where it will stand; words and roles switch at
 * the middle. Painting order is the second scene's, with the shapes that are leaving drawn first.
 */
export function lerpPictureScene(from: PictureScene, to: PictureScene, progress: number): PictureScene {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const later = new Map(to.shapes.map((shape) => [shape.key, shape]));
  const earlier = new Map(from.shapes.map((shape) => [shape.key, shape]));
  const leaving = from.shapes
    .filter((shape) => !later.has(shape.key))
    .map((shape) => ({ ...shape, opacity: shape.opacity * (1 - progress) }));
  const staying = to.shapes.map((shape) => {
    const before = earlier.get(shape.key);
    return before === undefined ? { ...shape, opacity: shape.opacity * progress } : blendShape(before, shape, progress);
  });
  return { ...to, shapes: [...leaving, ...staying] };
}
