import type { Picture } from '@knowscroll/scroll-model';
import type { TextShape } from '../scene';
import { layoutPicture } from '.';
import { shapesOutside, TEST_BOXES, TEXT_SCALES } from './scene-check';

const withCaption = (caption: string): Picture => ({
  id: 'orbit',
  kind: 'statement',
  title: 'Earth’s lean',
  caption,
  statement: { form: 'number', value: '23.4°', label: 'Earth’s lean' },
});

const captionOf = (picture: Picture, width: number, height: number, textScale: number): TextShape => {
  const scene = layoutPicture(picture, {}, { width, height, textScale });
  const found = scene.shapes.find((shape): shape is TextShape => shape.type === 'text' && shape.key === 'caption');
  if (found === undefined) throw new Error('no caption');
  return found;
};

describe('the caption of a picture', () => {
  it('has a mono face and a 47-character caption wraps inside a 320 x 190 plate', () => {
    const text = 'Not to scale: the real orbit is almost a circle';
    expect(text).toHaveLength(47);
    const scene = layoutPicture(withCaption(text), {}, { width: 320, height: 190, textScale: 1 });
    const caption = captionOf(withCaption(text), 320, 190, 1);
    expect(caption.family).toBe('mono');
    expect(caption.lines.join(' ')).toBe(text);
    expect(caption.lines.length).toBeLessThanOrEqual(2);
    // A mono glyph is about 0.6 em wide: the real width of the line, not the sans estimate.
    for (const line of caption.lines)
      expect(caption.x + line.length * caption.size * 0.6).toBeLessThanOrEqual(320 - 12);
    expect(shapesOutside(scene)).toEqual([]);
  });

  it.each(TEST_BOXES.flatMap((size) => TEXT_SCALES.map((scale) => ({ size, scale }))))(
    'keeps the longest caption whole, in at most three lines, inside the plate at $size.width x $size.height, text $scale',
    ({ size, scale }) => {
      const text =
        'Schematic, after the 1855 map: the pump on Broad Street, the deaths marked, and the nearer wells all dry';
      const picture = withCaption(text.padEnd(120, '.').slice(0, 120));
      const caption = captionOf(picture, size.width, size.height, scale);
      expect(caption.lines.length).toBeLessThanOrEqual(3);
      expect(caption.lines.some((line) => line.endsWith('…'))).toBe(false);
      for (const line of caption.lines)
        expect(caption.x + line.length * caption.size * 0.6).toBeLessThanOrEqual(size.width);
      expect(shapesOutside(layoutPicture(picture, {}, { ...size, textScale: scale }))).toEqual([]);
    },
  );
});
