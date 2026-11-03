import { render } from '@testing-library/react-native';
import {
  INITIAL_STAGE_STATE,
  settleStageState,
  STAGE_ENUMS,
  type StageFigure,
  type StageState,
} from '@knowscroll/scroll-model';
import { labelBox, TEXT_PILL, type Box, type SceneLabel } from './earth-sky-boxes';
import { compactFigure, dayBands, distanceMarks, leaderBoxes } from './earth-sky-figures';
import { orbitLayout } from './earth-sky-orbit-layout';
import { orbitFrame, sceneOf, SCENE_HEIGHT, SCENE_WIDTH } from './earth-sky-scene';
import { KIT_PICTURES } from './registry';

/**
 * CI fixtures, never product content: the figures are those of the invented planet Orrin in the tests of the document, so
 * nothing here states a fact about the world.
 */
const NEAREST: StageFigure = { slot: 'nearest', value: 41_000_000, unit: 'kilometres' };
const FARTHEST: StageFigure = { slot: 'farthest', value: 43_000_000, unit: 'kilometres' };
const JUNE: StageFigure = { slot: 'june-daylight', value: 14, unit: 'hours', place: 'Pell' };
const DECEMBER: StageFigure = { slot: 'december-daylight', value: 10, unit: 'hours', place: 'Pell' };

const state = (patch: Partial<StageState>): StageState => settleStageState({ ...INITIAL_STAGE_STATE, ...patch });

describe('a distance as the picture writes it', () => {
  it('writes millions with an M and a common unit short, and leaves any other unit as the passage has it', () => {
    expect(compactFigure(NEAREST)).toBe('41 M km');
    expect(compactFigure({ value: 91_400_000, unit: 'miles' })).toBe('91.4 M mi');
    expect(compactFigure({ value: 152_100_000, unit: 'Kilometers' })).toBe('152.1 M km');
    expect(compactFigure({ value: 4_300, unit: 'kilometres' })).toBe('4,300 km');
    expect(compactFigure({ value: 3.2, unit: 'astronomical units' })).toBe('3.2 astronomical units');
  });
});

describe('the marks of a distance picture (V3 F4)', () => {
  it('are drawn only for a state that carries a distance on an orbit view', () => {
    expect(distanceMarks(sceneOf(state({ view: 'orbit' })))).toBeUndefined();
    expect(distanceMarks(sceneOf(state({ view: 'sun-earth', figures: [NEAREST] })))).toBeUndefined();
    const marks = distanceMarks(sceneOf(state({ view: 'orbit', earthAt: 'oct', figures: [NEAREST, FARTHEST] })));
    expect(marks?.nearest?.name.text).toBe('NEAREST');
    expect(marks?.nearest?.value.text).toBe('41 M km');
    expect(marks?.farthest?.name.text).toBe('FARTHEST');
    expect(marks?.farthest?.value.text).toBe('43 M km');
    expect(marks?.here.label.text).toBe('YOU ARE HERE · OCT');
    expect(marks?.sunCaption.text).toBe('SUN NOT TO SCALE');
  });

  it('draw one end alone when only one distance is stated, with the line still through the Sun', () => {
    const marks = distanceMarks(sceneOf(state({ view: 'orbit-stretched', figures: [FARTHEST] })));
    expect(marks?.nearest).toBeUndefined();
    expect(marks?.farthest?.value.text).toBe('43 M km');
    expect(marks?.axis.from.y).toBe(marks?.axis.to.y);
  });

  const everyPicture: { readonly name: string; readonly scene: ReturnType<typeof sceneOf> }[] = (
    ['orbit', 'orbit-stretched'] as const
  ).flatMap((view) =>
    STAGE_ENUMS.earthAt.flatMap((earthAt) =>
      [[NEAREST, FARTHEST], [NEAREST], [FARTHEST]].map((figures) => ({
        name: `${view} ${earthAt} ${figures.map((figure) => figure.slot).join('+')}`,
        scene: sceneOf(state({ view, earthAt, figures })),
      })),
    ),
  );

  it('keep every label inside the frame, clear of the phone’s TEXT pill and clear of each other, in every month and view', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyPicture) {
      const marks = distanceMarks(scene);
      if (marks === undefined) throw new Error(`${name} has marks`);
      const labels: SceneLabel[] = [
        marks.sunCaption,
        marks.here.label,
        ...[marks.nearest, marks.farthest].flatMap((end) => (end === undefined ? [] : [end.name, end.value])),
      ];
      const boxes: [string, Box][] = labels.map((label) => [label.text, labelBox(label)]);
      boxes.forEach(([text, box], at) => {
        if (box.left < 2 || box.right > SCENE_WIDTH - 2 || box.top < 0 || box.bottom > SCENE_HEIGHT)
          problems.push(`${name}: "${text}" leaves the frame`);
        if (box.right > TEXT_PILL.left && box.bottom > TEXT_PILL.top)
          problems.push(`${name}: "${text}" reaches the TEXT pill`);
        for (const [other, otherBox] of boxes.slice(at + 1))
          if (
            box.left < otherBox.right &&
            otherBox.left < box.right &&
            box.top < otherBox.bottom &&
            otherBox.top < box.bottom
          )
            problems.push(`${name}: "${text}" covers "${other}"`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('keep clear of the Sun, of Earth and of the dotted line through the Sun, and keep the pin inside the frame', () => {
    const covers = (first: Box, second: Box) =>
      first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
    const around = (at: { x: number; y: number }, reach: number): Box => ({
      left: at.x - reach,
      right: at.x + reach,
      top: at.y - reach,
      bottom: at.y + reach,
    });
    const problems: string[] = [];
    for (const { name, scene } of everyPicture) {
      const marks = distanceMarks(scene);
      if (marks === undefined) throw new Error(`${name} has marks`);
      const frame = orbitFrame(scene);
      const here = labelBox(marks.here.label);
      if (covers(here, around(frame.sun, frame.sunRadius + 10)))
        problems.push(`${name}: "you are here" covers the Sun`);
      if (covers(here, { left: 0, right: SCENE_WIDTH, top: frame.centre.y - 2, bottom: frame.centre.y + 2 }))
        problems.push(`${name}: "you are here" sits on the dotted line`);
      if (covers(here, around(frame.earth, frame.earthRadius))) problems.push(`${name}: "you are here" covers Earth`);
      if (covers(labelBox(marks.sunCaption), around(frame.earth, frame.earthRadius)))
        problems.push(`${name}: the Sun's words cover Earth`);
      const leaders = [marks.nearest, marks.farthest].flatMap((end) =>
        end === undefined ? [] : leaderBoxes(end.leader),
      );
      for (const [words, box] of [
        ['you are here', here],
        ['the Sun’s words', labelBox(marks.sunCaption)],
      ] as const)
        if (leaders.some((leader) => covers(box, leader))) problems.push(`${name}: "${words}" crosses a leader`);
      const tipToTop = marks.here.pinUp ? marks.here.pin.y - 13 : marks.here.pin.y;
      const tipToBottom = marks.here.pinUp ? marks.here.pin.y : marks.here.pin.y + 13;
      if (tipToTop < 0 || tipToBottom > SCENE_HEIGHT) problems.push(`${name}: the pin leaves the frame`);
    }
    expect(problems).toEqual([]);
  });

  it('keep the "you are here" words off the names the orbit view already has for its four turning points', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyPicture) {
      const here = labelBox(distanceMarks(scene)!.here.label);
      for (const { month, label } of orbitLayout(scene).months) {
        const box = labelBox(label);
        if (here.left < box.right && box.left < here.right && here.top < box.bottom && box.top < here.bottom)
          problems.push(`${name}: covers ${month}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('the bands of a day (V3 F7)', () => {
  it('are one for each daylight figure on the Sun and Earth view, June above December, lit as long as the hours are of a day', () => {
    const bands = dayBands(sceneOf(state({ view: 'sun-earth', figures: [DECEMBER, JUNE] })));
    expect(bands.map((band) => band.slot)).toEqual(['june-daylight', 'december-daylight']);
    expect(bands.map((band) => band.label.text)).toEqual(['JUNE · PELL · 14 HOURS', 'DECEMBER · PELL · 10 HOURS']);
    const [june, december] = bands;
    expect(june?.lit).toBeCloseTo((14 / 24) * (june?.bar.width ?? 0), 6);
    expect(december?.lit).toBeCloseTo((10 / 24) * (december?.bar.width ?? 0), 6);
    expect(june?.bar.y).toBeLessThan(december?.bar.y ?? 0);
    for (const band of bands) {
      const box = labelBox(band.label);
      expect(box.left).toBeGreaterThanOrEqual(2);
      expect(box.bottom).toBeLessThanOrEqual(SCENE_HEIGHT);
      expect(band.bar.y + band.bar.height).toBeLessThanOrEqual(SCENE_HEIGHT);
    }
  });

  it('are none elsewhere, and a long place name is cut so the words stay inside the frame', () => {
    expect(dayBands(sceneOf(state({ view: 'orbit', figures: [JUNE] })))).toEqual([]);
    expect(dayBands(sceneOf(state({ view: 'earth-close', figures: [JUNE] })))).toEqual([]);
    expect(dayBands(sceneOf(state({ view: 'sun-earth' })))).toEqual([]);
    const long = { ...DECEMBER, place: 'The harbour town of Pell on the northern coast', value: 10.5 };
    const band = dayBands(sceneOf(state({ view: 'sun-earth', figures: [long] })))[0];
    // Cut at a word, with an ellipsis that says it was cut.
    expect(band?.label.text).toBe('DECEMBER · THE HARBOUR TOWN OF… · 10.5 HOURS');
    expect(labelBox(band!.label).right).toBeLessThan(TEXT_PILL.left);
    const textOf = (place: string) =>
      dayBands(sceneOf(state({ view: 'sun-earth', figures: [{ ...DECEMBER, place }] })))[0]?.label.text;
    // A name that fits is written whole, one that ends in the middle of a word is cut before the word, and one long word is cut in it.
    expect(textOf('Thiruvananthapuram')).toBe('DECEMBER · THIRUVANANTHAPURAM · 10 HOURS');
    expect(textOf('Thiruvananthapuram Kerala South India')).toBe('DECEMBER · THIRUVANANTHAPURAM… · 10 HOURS');
    expect(textOf('Llanfairpwllgwyngyllgogerychwyrndrobwll')).toBe('DECEMBER · LLANFAIRPWLLGWYNGYL… · 10 HOURS');
  });
});

type Node = {
  readonly type?: string;
  readonly props?: Record<string, unknown>;
  readonly children?: readonly unknown[] | null;
};

/** Every text the drawing holds: an SVG text keeps its words in the `content` of its span. */
function svgTexts(tree: unknown): string[] {
  const walk = (node: unknown): Node[] =>
    typeof node === 'object' && node !== null ? [node, ...((node as Node).children ?? []).flatMap(walk)] : [];
  return walk(tree)
    .filter((node) => node.type === 'RNSVGText')
    .map((node) =>
      (node.children ?? [])
        .map((child) => (child as Node).props?.['content'])
        .filter((content): content is string => typeof content === 'string')
        .join(''),
    );
}

describe('the picture draws the figures its state carries, and nothing else', () => {
  const picture = KIT_PICTURES['earth-sky.v1'];
  const draw = async (patch: Partial<StageState>) => {
    const view = await render(<picture.Picture scene={picture.sceneOf(state(patch))} />);
    const words = svgTexts(view.toJSON());
    return { view, words };
  };

  it('shows the distances, the pin and the caption on an orbit view, and nothing of them without a figure', async () => {
    const plain = await draw({ view: 'orbit', earthAt: 'oct' });
    expect(plain.view.queryByTestId('stage-distances', { includeHiddenElements: true })).toBeNull();
    expect(plain.words.join('|')).not.toMatch(/NEAREST|FARTHEST|YOU ARE HERE|NOT TO SCALE/u);
    await plain.view.unmount();
    const { view, words } = await draw({ view: 'orbit', earthAt: 'oct', figures: [NEAREST, FARTHEST] });
    expect(view.getByTestId('stage-distances', { includeHiddenElements: true })).toBeTruthy();
    for (const expected of ['NEAREST', '41 M km', 'FARTHEST', '43 M km', 'YOU ARE HERE · OCT', 'SUN NOT TO SCALE'])
      expect(words).toContain(expected);
  });

  it('shows the bands of a day on the Sun and Earth view and none on the close view', async () => {
    const { view, words } = await draw({ view: 'sun-earth', earthAt: 'jun', figures: [JUNE, DECEMBER] });
    expect(view.getByTestId('stage-day-bands', { includeHiddenElements: true })).toBeTruthy();
    expect(words).toEqual(expect.arrayContaining(['JUNE · PELL · 14 HOURS', 'DECEMBER · PELL · 10 HOURS']));
    await view.unmount();
    const close = await draw({ view: 'earth-close', earthAt: 'jun', figures: [JUNE] });
    expect(close.view.queryByTestId('stage-day-bands', { includeHiddenElements: true })).toBeNull();
  });
});
