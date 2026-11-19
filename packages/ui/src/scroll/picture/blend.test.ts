import { canGlidePictures, lerpPictureScene } from './blend';
import type { CircleShape, PictureScene, PictureShape, RectShape, TextShape } from './scene';

const rect = (key: string, patch: Partial<RectShape> = {}): RectShape => ({
  type: 'rect',
  key,
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  cornerRadius: 2,
  fill: 'raised',
  stroke: 'ink',
  strokeWidth: 1,
  opacity: 1,
  ...patch,
});

const circle = (key: string, patch: Partial<CircleShape> = {}): CircleShape => ({
  type: 'circle',
  key,
  cx: 5,
  cy: 5,
  r: 4,
  fill: 'ink',
  stroke: 'none',
  strokeWidth: 0,
  opacity: 1,
  ...patch,
});

const words = (key: string, lines: readonly string[], patch: Partial<TextShape> = {}): TextShape => ({
  type: 'text',
  key,
  x: 10,
  y: 20,
  lines,
  size: 12,
  lineHeight: 14,
  weight: 'regular',
  anchor: 'start',
  fill: 'ink',
  family: 'sans',
  opacity: 1,
  ...patch,
});

const sceneOf = (shapes: readonly PictureShape[], patch: Partial<PictureScene> = {}): PictureScene => ({
  pictureId: 'orbit',
  width: 320,
  height: 190,
  shapes,
  ...patch,
});

const named = (scene: PictureScene, key: string): PictureShape => {
  const found = scene.shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found;
};

describe('canGlidePictures', () => {
  it('is true for one picture in one box', () => {
    expect(canGlidePictures(sceneOf([]), sceneOf([rect('a')]))).toBe(true);
  });

  it('is false for another picture', () => {
    expect(canGlidePictures(sceneOf([]), sceneOf([], { pictureId: 'sky' }))).toBe(false);
  });

  it('is false for the same picture in another box', () => {
    expect(canGlidePictures(sceneOf([]), sceneOf([], { width: 390 }))).toBe(false);
    expect(canGlidePictures(sceneOf([]), sceneOf([], { height: 287 }))).toBe(false);
  });
});

describe('lerpPictureScene', () => {
  const from = sceneOf([rect('a', { x: 0, opacity: 1 })]);
  const to = sceneOf([rect('a', { x: 100, opacity: 0.5 })]);

  it('is the first scene at 0 and the second at 1', () => {
    expect(lerpPictureScene(from, to, 0)).toBe(from);
    expect(lerpPictureScene(from, to, 1)).toBe(to);
  });

  it('moves a shape found in both scenes by its key, number by number', () => {
    const middle = lerpPictureScene(from, to, 0.5);
    expect(middle.shapes).toHaveLength(1);
    expect(middle.shapes[0]).toMatchObject({ key: 'a', x: 50, opacity: 0.75, width: 10 });
    expect(named(lerpPictureScene(from, to, 0.25), 'a')).toMatchObject({ x: 25 });
  });

  it('matches by key, not by position', () => {
    const before = sceneOf([rect('a', { x: 0 }), rect('b', { x: 40 })]);
    const after = sceneOf([rect('b', { x: 80 }), rect('a', { x: 20 })]);
    const middle = lerpPictureScene(before, after, 0.5);
    expect(named(middle, 'a')).toMatchObject({ x: 10 });
    expect(named(middle, 'b')).toMatchObject({ x: 60 });
  });

  it('fades out a shape only in the first scene, where it stood, and draws it before the others', () => {
    const middle = lerpPictureScene(sceneOf([rect('gone', { x: 7 }), rect('kept')]), sceneOf([rect('kept')]), 0.25);
    expect(middle.shapes.map((shape) => shape.key)).toEqual(['gone', 'kept']);
    expect(named(middle, 'gone')).toMatchObject({ x: 7, opacity: 0.75 });
  });

  it('fades in a shape only in the second scene, where it will stand', () => {
    const middle = lerpPictureScene(sceneOf([rect('kept')]), sceneOf([rect('kept'), rect('new', { x: 9 })]), 0.25);
    expect(named(middle, 'new')).toMatchObject({ x: 9, opacity: 0.25 });
  });

  it('keeps the fade proportional to the opacity the shape has in its own scene', () => {
    const middle = lerpPictureScene(
      sceneOf([rect('gone', { opacity: 0.6 })]),
      sceneOf([rect('new', { opacity: 0.6 })]),
      0.5,
    );
    expect(named(middle, 'gone').opacity).toBeCloseTo(0.3, 12);
    expect(named(middle, 'new').opacity).toBeCloseTo(0.3, 12);
  });

  it('switches a shape that changes type at the middle, whole, and never blends the two', () => {
    const before = sceneOf([rect('a', { x: 0 })]);
    const after = sceneOf([circle('a', { cx: 50 })]);
    expect(lerpPictureScene(before, after, 0.49).shapes).toEqual([before.shapes[0]]);
    expect(lerpPictureScene(before, after, 0.5).shapes).toEqual([after.shapes[0]]);
    expect(lerpPictureScene(before, after, 0.9).shapes).toEqual([after.shapes[0]]);
  });

  it('switches words, and the roles and weights that go with them, at the middle', () => {
    const before = sceneOf([words('label', ['Before'], { x: 0, fill: 'ink2', weight: 'regular' })]);
    const after = sceneOf([words('label', ['After', 'and more'], { x: 40, fill: 'mark', weight: 'bold' })]);
    expect(named(lerpPictureScene(before, after, 0.4), 'label')).toMatchObject({
      lines: ['Before'],
      fill: 'ink2',
      weight: 'regular',
      x: 16,
    });
    expect(named(lerpPictureScene(before, after, 0.6), 'label')).toMatchObject({
      lines: ['After', 'and more'],
      fill: 'mark',
      weight: 'bold',
      x: 24,
    });
  });

  it('takes the second scene’s box and picture and its painting order for the shapes it keeps', () => {
    const before = sceneOf([rect('a'), rect('b')]);
    const after = sceneOf([rect('b'), rect('a')]);
    expect(lerpPictureScene(before, after, 0.5).shapes.map((shape) => shape.key)).toEqual(['b', 'a']);
    expect(lerpPictureScene(before, after, 0.5)).toMatchObject({ pictureId: 'orbit', width: 320, height: 190 });
  });
});
