import type { PictureOfKind } from '@knowscroll/scroll-model';
import type { ArcShape, CircleShape, PictureBox, PictureScene, TextShape } from '../scene';
import { RECEDED } from './common';
import { layoutCycle } from './cycle';
import {
  boundsOverlap,
  distanceFromPoint,
  hasUniqueKeys,
  keysOf,
  overlappingTexts,
  shapesOutside,
  TEST_BOXES,
  TEXT_SCALES,
  textBounds,
} from './scene-check';

type CyclePicture = PictureOfKind<'cycle'>;

const ITEMS = [
  { id: 'january', label: 'January' },
  { id: 'march', label: 'March equinox' },
  { id: 'june', label: 'June solstice', tone: 'warm' as const },
  { id: 'july', label: 'July' },
  { id: 'september', label: 'September equinox' },
  { id: 'december', label: 'December solstice', tone: 'cool' as const },
  { id: 'february', label: 'February' },
  { id: 'august', label: 'Midwinter' },
];

/** A ring of `count` items, with the Sun at its centre when `centred`. */
function ringOf(count: number, centred: boolean): CyclePicture {
  return {
    id: 'seasons',
    kind: 'cycle',
    title: 'The seasons',
    ...(centred ? { centre: { id: 'sun', label: 'Sun', tone: 'warm' as const } } : {}),
    items: ITEMS.slice(0, count),
  };
}

const boxOf = (size: Omit<PictureBox, 'textScale'>, textScale: number): PictureBox => ({ ...size, textScale });
const circlesOf = (scene: PictureScene): CircleShape[] =>
  scene.shapes.filter((shape): shape is CircleShape => shape.type === 'circle');
const arcsOf = (scene: PictureScene): ArcShape[] =>
  scene.shapes.filter((shape): shape is ArcShape => shape.type === 'arc');
const textsOf = (scene: PictureScene): TextShape[] =>
  scene.shapes.filter((shape): shape is TextShape => shape.type === 'text');
const named = <Shape extends { key: string }>(shapes: readonly Shape[], key: string): Shape => {
  const found = shapes.find((shape) => shape.key === key);
  if (found === undefined) throw new Error(`no shape ${key}`);
  return found;
};

const CASES = TEST_BOXES.flatMap((size) =>
  TEXT_SCALES.flatMap((scale) =>
    [3, 6, 8].flatMap((count) =>
      [false, true].map((centred) => ({
        size,
        scale,
        count,
        centred,
        name: `${size.width}x${size.height} at ${scale * 100}%, ${count} items${centred ? ' round a centre' : ''}`,
      })),
    ),
  ),
);

describe('layoutCycle', () => {
  describe.each(CASES)('$name', ({ size, scale, count, centred }) => {
    const picture = ringOf(count, centred);
    const scene = layoutCycle(picture, {}, boxOf(size, scale));

    it('keeps every shape inside the box', () => {
      expect(shapesOutside(scene)).toEqual([]);
    });

    it('never lets two labels overlap', () => {
      expect(overlappingTexts(scene)).toEqual([]);
    });

    it('keeps every label clear of every node and outside the ring', () => {
      const { r } = named(arcsOf(scene), `arc-january-march`);
      for (const label of textsOf(scene)) {
        const bounds = textBounds(label);
        for (const node of circlesOf(scene)) {
          expect(
            boundsOverlap(bounds, {
              left: node.cx - node.r,
              right: node.cx + node.r,
              top: node.cy - node.r,
              bottom: node.cy + node.r,
            }),
          ).toBe(false);
        }
        if (label.key !== 'sun-label')
          expect(distanceFromPoint(bounds, scene.width / 2, scene.height / 2)).toBeGreaterThan(r);
      }
    });

    it('has the same unique keys in every state of the picture', () => {
      const lit = layoutCycle(picture, { upTo: 2, lit: ['january'] }, boxOf(size, scale));
      expect(hasUniqueKeys(scene)).toBe(true);
      expect(keysOf(lit)).toEqual(keysOf(scene));
    });

    it('is the same scene for the same input', () => {
      expect(layoutCycle(ringOf(count, centred), {}, boxOf(size, scale))).toEqual(scene);
    });
  });

  describe('the ring', () => {
    const box = boxOf({ width: 390, height: 287 }, 1);
    const scene = layoutCycle(ringOf(6, true), {}, box);
    const nodes = ITEMS.slice(0, 6).map((item) => named(circlesOf(scene), `${item.id}-node`));
    const centre = { x: box.width / 2, y: box.height / 2 };

    it('puts the first item at the top and the rest clockwise on one circle', () => {
      expect(nodes[0]?.cx).toBeCloseTo(centre.x);
      expect(nodes[0]?.cy).toBeLessThan(centre.y);
      const radius = Math.hypot((nodes[0]?.cx ?? 0) - centre.x, (nodes[0]?.cy ?? 0) - centre.y);
      const angles = nodes.map((node) => {
        expect(Math.hypot(node.cx - centre.x, node.cy - centre.y)).toBeCloseTo(radius);
        return (Math.atan2(node.cy - centre.y, node.cx - centre.x) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
      });
      angles.forEach((angle, index) => expect(angle).toBeCloseTo((2 * Math.PI * index) / 6));
    });

    it('draws an arrowed arc from each item to the next and the last back to the first', () => {
      expect(arcsOf(scene)).toHaveLength(6);
      expect(arcsOf(scene).every((arc) => arc.arrow && arc.to > arc.from)).toBe(true);
      expect(arcsOf(scene).map((arc) => arc.key)).toEqual([
        'arc-january-march',
        'arc-march-june',
        'arc-june-july',
        'arc-july-september',
        'arc-september-december',
        'arc-december-january',
      ]);
      // Each arc ends before the angle of the item it leads to, and starts after the angle of the one it leaves.
      const last = named(arcsOf(scene), 'arc-december-january');
      expect(last.from).toBeGreaterThan(-Math.PI / 2 + (2 * Math.PI * 5) / 6);
      expect(last.to).toBeLessThan(-Math.PI / 2 + 2 * Math.PI);
    });

    it('places a label beside each node on the sides and above or below at the top and bottom', () => {
      const label = (id: string) => named(textsOf(scene), `${id}-label`);
      expect(label('january').anchor).toBe('middle');
      expect(label('january').y).toBeLessThan(nodes[0]?.cy ?? 0);
      expect(label('july').anchor).toBe('middle');
      expect(label('july').y).toBeGreaterThan(named(circlesOf(scene), 'july-node').cy);
      expect(label('march').anchor).toBe('start');
      expect(label('march').x).toBeGreaterThan(named(circlesOf(scene), 'march-node').cx);
      expect(label('december').anchor).toBe('end');
      expect(label('december').x).toBeLessThan(named(circlesOf(scene), 'december-node').cx);
    });

    it('fills each node with its tone, or leaves it light without one', () => {
      expect(named(circlesOf(scene), 'june-node').fill).toBe('warm');
      expect(named(circlesOf(scene), 'december-node').fill).toBe('cool');
      expect(named(circlesOf(scene), 'january-node').fill).toBe('raised');
    });
  });

  describe('the centre', () => {
    const scene = layoutCycle(ringOf(6, true), {}, boxOf({ width: 390, height: 287 }, 1));

    it('is a larger circle in the middle, in the role of its tone', () => {
      const sun = named(circlesOf(scene), 'sun-node');
      expect(sun.fill).toBe('warm');
      expect(sun.r).toBeGreaterThan(named(circlesOf(scene), 'january-node').r);
      expect(Math.abs(sun.cx - 195)).toBeLessThan(1);
    });

    it('is named below its circle in ink, never on a meaning colour', () => {
      const sun = named(circlesOf(scene), 'sun-node');
      const label = named(textsOf(scene), 'sun-label');
      expect(textBounds(label).top).toBeGreaterThanOrEqual(sun.cy + sun.r);
      expect(label.fill).toBe('ink');
      expect(label.part).toBe('sun');
    });

    it('is left out of a ring without one', () => {
      const bare = layoutCycle(ringOf(6, false), {}, boxOf({ width: 390, height: 287 }, 1));
      expect(circlesOf(bare)).toHaveLength(6);
    });

    it('is never hidden by upTo', () => {
      const early = layoutCycle(ringOf(6, true), { upTo: 1 }, boxOf({ width: 390, height: 287 }, 1));
      expect(named(early.shapes, 'sun-node').opacity).toBe(1);
    });
  });

  describe('states', () => {
    const box = boxOf({ width: 390, height: 287 }, 1);
    const opacityOf = (scene: PictureScene, key: string): number => named(scene.shapes, key).opacity;

    it('draws everything at full strength with an empty state', () => {
      expect(layoutCycle(ringOf(6, true), {}, box).shapes.every((shape) => shape.opacity === 1)).toBe(true);
    });

    it('hides the items after upTo and every arc touching them, keeping all in the scene', () => {
      const scene = layoutCycle(ringOf(6, true), { upTo: 3 }, box);
      for (const key of ['january-node', 'march-label', 'june-node', 'arc-january-march', 'arc-march-june'])
        expect(opacityOf(scene, key)).toBe(1);
      for (const key of [
        'july-node',
        'july-label',
        'december-node',
        'arc-june-july',
        'arc-september-december',
        'arc-december-january',
      ])
        expect(opacityOf(scene, key)).toBe(0);
    });

    it('closes the ring only when every item is reached', () => {
      expect(opacityOf(layoutCycle(ringOf(6, false), { upTo: 5 }, box), 'arc-december-january')).toBe(0);
      expect(opacityOf(layoutCycle(ringOf(6, false), { upTo: 6 }, box), 'arc-december-january')).toBe(1);
    });

    it('moves nothing when an item is reached', () => {
      const early = layoutCycle(ringOf(6, true), { upTo: 2 }, box);
      const late = layoutCycle(ringOf(6, true), {}, box);
      expect(named(circlesOf(early), 'september-node').cx).toBe(named(circlesOf(late), 'september-node').cx);
      expect(named(arcsOf(early), 'arc-march-june').from).toBe(named(arcsOf(late), 'arc-march-june').from);
    });

    it('draws a lit item bigger, filled in the mark colour or its tone, with a bold label, and recedes the rest', () => {
      const scene = layoutCycle(ringOf(6, true), { lit: ['january', 'june'] }, box);
      const plain = layoutCycle(ringOf(6, true), {}, box);
      const january = named(circlesOf(scene), 'january-node');
      expect(january.fill).toBe('mark');
      expect(january.r).toBeGreaterThan(named(circlesOf(plain), 'january-node').r);
      expect(named(circlesOf(scene), 'june-node').fill).toBe('warm');
      expect(named(textsOf(scene), 'january-label').weight).toBe('bold');
      expect(named(textsOf(scene), 'january-label').opacity).toBe(1);
      expect(named(circlesOf(scene), 'march-node').opacity).toBe(RECEDED);
      expect(named(textsOf(scene), 'march-label')).toMatchObject({ weight: 'regular', opacity: RECEDED });
      expect(opacityOf(scene, 'sun-node')).toBe(RECEDED);
    });

    it('lights the centre like any item', () => {
      const scene = layoutCycle(ringOf(6, true), { lit: ['sun'] }, box);
      expect(named(circlesOf(scene), 'sun-node').stroke).toBe('mark');
      expect(named(textsOf(scene), 'sun-label').weight).toBe('bold');
      expect(opacityOf(scene, 'january-node')).toBe(RECEDED);
    });

    it('keeps lit labels inside the box and clear of each other', () => {
      const scene = layoutCycle(ringOf(8, true), { lit: ITEMS.slice(0, 4).map((item) => item.id) }, box);
      expect(shapesOutside(scene)).toEqual([]);
      expect(overlappingTexts(scene)).toEqual([]);
    });

    it('names each part by the item it draws', () => {
      const scene = layoutCycle(ringOf(3, true), {}, box);
      expect(named(scene.shapes, 'march-node').part).toBe('march');
      expect(named(scene.shapes, 'march-label').part).toBe('march');
      expect(named(scene.shapes, 'sun-node').part).toBe('sun');
    });
  });

  it('draws the seasons orbit: a warm Sun, a warm June solstice and a cool December solstice', () => {
    const scene = layoutCycle(ringOf(6, true), {}, boxOf({ width: 320, height: 190 }, 1));
    expect(named(circlesOf(scene), 'sun-node').fill).toBe('warm');
    expect(textsOf(scene).map((text) => text.lines.join(' '))).toEqual(
      expect.arrayContaining([
        'Sun',
        'January',
        'March equinox',
        'June solstice',
        'July',
        'September equinox',
        'December solstice',
      ]),
    );
  });
});
