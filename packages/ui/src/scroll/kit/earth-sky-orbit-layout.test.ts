import {
  INITIAL_STAGE_STATE,
  settleStageState,
  STAGE_ENUMS,
  type StageFigure,
  type StageState,
} from '@knowscroll/scroll-model';
import { labelBox, TEXT_PILL, type Box, type SceneLabel } from './earth-sky-boxes';
import { distanceMarks } from './earth-sky-figures';
import { orbitLayout, recapPlaces } from './earth-sky-orbit-layout';
import {
  AXIS_DOT_RADIUS,
  AXIS_REACH,
  axisDirection,
  MONTH_ANGLE_DEGREES,
  orbitFrame,
  RECAP_FRAME,
  recapSceneOf,
  sceneOf,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type EarthSkyScene,
  type Point,
} from './earth-sky-scene';

/**
 * Every place the orbit views and the recap can put something, for every month they can draw (D-393). The geometry here is
 * the tests' own: an Earth is sampled as the points of its disc, its axis and the dot at its north end, a label as its box, and a
 * thing "overlaps" another when a sample lies inside it, so a mistake in the layout's own boxes cannot hide itself. CI fixtures,
 * never product content: the figures are those of the invented planet Orrin.
 */
const NEAREST: StageFigure = { slot: 'nearest', value: 41_000_000, unit: 'kilometres' };
const FARTHEST: StageFigure = { slot: 'farthest', value: 43_000_000, unit: 'kilometres' };
const state = (patch: Partial<StageState>): StageState => settleStageState({ ...INITIAL_STAGE_STATE, ...patch });
const MONTHS = STAGE_ENUMS.earthAt;
const ORBITS = ['orbit', 'orbit-stretched'] as const;

/** The points of an Earth: its rim and inside, its axis from end to end, and the dot at the north end. */
function earthPoints(at: Point, radius: number, axisTurn: number, reach: number): Point[] {
  const axis = axisDirection(axisTurn);
  const points: Point[] = [at];
  for (let degrees = 0; degrees < 360; degrees += 10) {
    const x = Math.cos((degrees * Math.PI) / 180);
    const y = Math.sin((degrees * Math.PI) / 180);
    for (const share of [1, 0.5]) points.push({ x: at.x + x * radius * share, y: at.y + y * radius * share });
    points.push({
      x: at.x + axis.x * radius * reach + x * AXIS_DOT_RADIUS,
      y: at.y + axis.y * radius * reach + y * AXIS_DOT_RADIUS,
    });
  }
  for (let step = -radius * reach; step <= radius * reach; step += 0.5)
    points.push({ x: at.x + axis.x * step, y: at.y + axis.y * step });
  return points;
}

const inside = (point: Point, box: Box): boolean =>
  point.x > box.left && point.x < box.right && point.y > box.top && point.y < box.bottom;
const apartBy = (first: readonly Point[], second: readonly Point[], gap: number): boolean =>
  first.every((one) => second.every((other) => Math.hypot(one.x - other.x, one.y - other.y) >= gap));
const overlaps = (first: Box, second: Box): boolean =>
  first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
const inFrame = (point: Point): boolean =>
  point.x >= 0 && point.x <= SCENE_WIDTH && point.y >= 0 && point.y <= SCENE_HEIGHT;
const labelFitsFrame = (box: Box): boolean =>
  box.left >= 2 &&
  box.right <= SCENE_WIDTH - 2 &&
  box.top >= 0 &&
  box.bottom <= SCENE_HEIGHT &&
  !(box.right > TEXT_PILL.left && box.bottom > TEXT_PILL.top);

/** What the orbit view draws for a scene, as the tests measure it. */
function drawn(scene: EarthSkyScene) {
  const layout = orbitLayout(scene);
  const { frame } = layout;
  const earths: { name: string; points: Point[] }[] = [
    {
      name: `Earth of ${scene.month}`,
      points: earthPoints(frame.earth, frame.earthRadius, scene.axisTurn, AXIS_REACH),
    },
    ...layout.months.flatMap(({ month, pale }) =>
      pale === undefined
        ? []
        : [{ name: `pale ${month}`, points: earthPoints(pale.at, pale.radius, scene.axisTurn, AXIS_REACH) }],
    ),
  ];
  const labels: { name: string; label: SceneLabel }[] = layout.months.map(({ month, label }) => ({
    name: `name ${month}`,
    label,
  }));
  const marks = distanceMarks(scene);
  if (marks !== undefined) {
    labels.push({ name: 'Sun words', label: marks.sunCaption }, { name: 'you are here', label: marks.here.label });
    for (const end of [marks.nearest, marks.farthest])
      if (end !== undefined)
        labels.push({ name: end.name.text, label: end.name }, { name: `${end.name.text} figure`, label: end.value });
  }
  const sun = { at: frame.sun, reach: frame.sunRadius + 9 };
  return { earths, labels, sun };
}

const everyOrbitScene: { readonly name: string; readonly scene: EarthSkyScene }[] = ORBITS.flatMap((view) =>
  MONTHS.flatMap((earthAt) =>
    [[], [NEAREST, FARTHEST], [NEAREST], [FARTHEST]].map((figures) => ({
      name: `${view} ${earthAt} with ${figures.length === 0 ? 'no figure' : figures.map((figure) => figure.slot).join(' and ')}`,
      scene: sceneOf(state({ view, earthAt, figures })),
    })),
  ),
);

describe('the orbit views lay every Earth and word out clear of each other, for every month (D-393)', () => {
  it('covers both orbit shapes, every month and every set of figures', () => {
    expect(ORBITS.length * MONTHS.length * 4).toBe(everyOrbitScene.length);
    expect(MONTHS).toHaveLength(12);
  });

  it('keeps every word inside the frame and clear of the TEXT pill', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyOrbitScene)
      for (const { name: word, label } of drawn(scene).labels)
        if (!labelFitsFrame(labelBox(label)))
          problems.push(`${name}: "${word}" leaves the frame or reaches the TEXT pill`);
    expect(problems).toEqual([]);
  });

  it('keeps every word clear of every other word', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyOrbitScene) {
      const { labels } = drawn(scene);
      labels.forEach((first, at) => {
        for (const second of labels.slice(at + 1))
          if (overlaps(labelBox(first.label), labelBox(second.label)))
            problems.push(`${name}: "${first.name}" covers "${second.name}"`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('keeps every word off every Earth, with its axis, that is drawn, and off the Sun with its rays', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyOrbitScene) {
      const { earths, labels, sun } = drawn(scene);
      for (const { name: word, label } of labels) {
        const box = labelBox(label);
        for (const earth of earths)
          if (earth.points.some((point) => inside(point, box)))
            problems.push(`${name}: "${word}" covers ${earth.name}`);
        const nearest = {
          x: Math.min(box.right, Math.max(box.left, sun.at.x)),
          y: Math.min(box.bottom, Math.max(box.top, sun.at.y)),
        };
        // The Sun's own words stand just off its rays, never on them.
        if (Math.hypot(nearest.x - sun.at.x, nearest.y - sun.at.y) < sun.reach)
          problems.push(`${name}: "${word}" covers the Sun`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps every word off the dashed orbit', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyOrbitScene) {
      const { frame } = orbitLayout(scene);
      const line: Point[] = Array.from({ length: 360 }, (_, degrees) => ({
        x: frame.centre.x + frame.halfWidth * Math.cos((degrees * Math.PI) / 180),
        y: frame.centre.y + frame.halfHeight * Math.sin((degrees * Math.PI) / 180),
      }));
      for (const { name: word, label } of drawn(scene).labels)
        if (line.some((point) => inside(point, labelBox(label)))) problems.push(`${name}: "${word}" is on the orbit`);
    }
    expect(problems).toEqual([]);
  });

  it('keeps every Earth clear of every other Earth, of the Sun and inside the frame', () => {
    const problems: string[] = [];
    for (const { name, scene } of everyOrbitScene) {
      const { earths, sun } = drawn(scene);
      earths.forEach((first, at) => {
        for (const second of earths.slice(at + 1))
          if (!apartBy(first.points, second.points, 1)) problems.push(`${name}: ${first.name} touches ${second.name}`);
        // The Sun's rays are hairlines: an axis may cross one, but no Earth reaches the disc.
        if (first.points.some((point) => Math.hypot(point.x - sun.at.x, point.y - sun.at.y) < sun.reach - 9))
          problems.push(`${name}: ${first.name} touches the Sun's disc`);
        if (!first.points.every(inFrame)) problems.push(`${name}: ${first.name} leaves the frame`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('leaves out only the pale Earth that the Earth of the month stands on or crowds, and names every turning point', () => {
    for (const month of MONTHS) {
      const scene = sceneOf(state({ view: 'orbit-stretched', earthAt: month }));
      const layout = orbitLayout(scene);
      expect(layout.months.map((mark) => mark.label.text)).toEqual(['DEC', 'MAR', 'JUN', 'SEP']);
      const absent = layout.months.filter((mark) => mark.pale === undefined).map((mark) => mark.month);
      // On the stretched orbit the months either side of December and of June crowd it; every other month leaves its neighbours alone.
      const expected = (
        {
          jan: ['dec'],
          nov: ['dec'],
          dec: ['dec'],
          mar: ['mar'],
          may: ['jun'],
          jun: ['jun'],
          jul: ['jun'],
          sep: ['sep'],
        } as Record<string, string[]>
      )[month];
      expect(absent).toEqual(expected ?? []);
    }
  });
});

describe('the recap lays every numbered Earth and badge out clear of each other, for any months it numbers (D-393)', () => {
  const plain = sceneOf(state({ view: 'orbit' }));
  const marksOf = (months: readonly (typeof MONTHS)[number][]) =>
    months.map((month, index) => ({ month, n: index + 1, angle: MONTH_ANGLE_DEGREES[month] }));
  const pairs = MONTHS.flatMap((first) => MONTHS.filter((second) => second !== first).map((second) => [first, second]));
  const triples = MONTHS.flatMap((first, at) =>
    MONTHS.slice(at + 1).flatMap((second, further) =>
      MONTHS.slice(at + further + 2).map((third) => [first, second, third]),
    ),
  );
  const sets = [...pairs, ...triples, [...MONTHS], [...MONTHS].reverse()] as (typeof MONTHS)[number][][];

  function problemsOf(months: (typeof MONTHS)[number][]): string[] {
    const places = recapPlaces(plain, marksOf(months));
    const bodies = places.map(({ earth }) =>
      earthPoints(earth, RECAP_FRAME.earthRadius, plain.axisTurn, RECAP_FRAME.axisReach),
    );
    const badgeDisc = ({ badge }: { badge: Point }): Point[] =>
      earthPoints(badge, RECAP_FRAME.badgeRadius, 0, 0).filter((point) => point !== badge);
    const found: string[] = [];
    const sun = { x: RECAP_FRAME.centre.x, y: RECAP_FRAME.centre.y, reach: 18 + 9 };
    places.forEach((place, at) => {
      const label = `${place.mark.n} (${place.mark.month})`;
      if (!bodies[at]!.every(inFrame)) found.push(`Earth ${label} leaves the frame`);
      if (bodies[at]!.some((point) => point.x > SCENE_WIDTH - RECAP_FRAME.peekClearance))
        found.push(`Earth ${label} is under the next Part's tab`);
      const disc = badgeDisc(place);
      if (!disc.every(inFrame)) found.push(`badge ${label} leaves the frame`);
      if (disc.some((point) => point.x > SCENE_WIDTH - RECAP_FRAME.peekClearance))
        found.push(`badge ${label} is under the next Part's tab`);
      if (Math.hypot(place.badge.x - sun.x, place.badge.y - sun.y) < sun.reach + RECAP_FRAME.badgeRadius)
        found.push(`badge ${label} covers the Sun`);
      places.forEach((other, further) => {
        if (further > at && !apartBy(bodies[at]!, bodies[further]!, 1))
          found.push(`Earth ${label} touches Earth ${other.mark.n}`);
        if (!apartBy(disc, bodies[further]!, 1)) found.push(`badge ${label} covers Earth ${other.mark.n}`);
        if (further > at && !apartBy(disc, badgeDisc(other), 1))
          found.push(`badge ${label} touches badge ${other.mark.n}`);
      });
    });
    return found;
  }

  it('is checked for every pair of months in both orders, every three months, and all twelve in either order', () => {
    expect(pairs).toHaveLength(132);
    expect(triples).toHaveLength(220);
    expect(sets).toHaveLength(132 + 220 + 2);
  });

  it('keeps every Earth and badge whole inside the frame, clear of each other, of the Sun and of the next Part’s tab', () => {
    const failing = sets.flatMap((months) => problemsOf(months).map((problem) => `${months.join(',')}: ${problem}`));
    expect(failing).toEqual([]);
  });

  it('puts the badge on the outer side of the orbit where there is room', () => {
    const [place] = recapPlaces(plain, marksOf(['jun', 'dec']));
    expect(place!.badge.x).toBeGreaterThan(place!.earth.x);
    const [, left] = recapPlaces(plain, marksOf(['jun', 'dec']));
    expect(left!.badge.x).toBeLessThan(left!.earth.x);
  });

  it('is what a real recap scene draws', () => {
    const scene = recapSceneOf([state({ view: 'orbit', earthAt: 'dec' }), state({ view: 'orbit', earthAt: 'jan' })]);
    expect(scene?.recap).toHaveLength(2);
    expect(problemsOf(['dec', 'jan'])).toEqual([]);
    expect(orbitFrame(plain).halfHeight).toBeLessThanOrEqual(63);
  });
});
