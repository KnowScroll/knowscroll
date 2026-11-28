import { fireEvent, render, screen } from '@testing-library/react-native';
import { buildGlobe, chartWorld, type WorldSpec } from '@knowscroll/scene-core';
import { SAMPLE_SEED, SAMPLE_SITE_COUNT, seamSiteOf } from '../../../gallery/maps-gallery-fixtures';
import { paletteOf } from '../../planet/planet-palette';
import { loopsToPath } from '../../planet/svg-paths';
import { centreOfCell } from '../region-centre';
import { BAND_WIDTH } from '../world-texture';
import { FlatPlanet, greyOf, type FlatPlanetProps } from './flat-planet';
import { copiesOf, cropOf, WHOLE_BAND } from './map-layout';

const spec: WorldSpec = { seed: SAMPLE_SEED, type: 'lush', variant: 0, siteCount: SAMPLE_SITE_COUNT };
const world = buildGlobe(spec);
const palette = paletteOf('lush', 0);
const grey = greyOf(palette);
const seamSite = seamSiteOf(spec)!;
const size = { width: 360, height: 270 };
/** The drawing is out of reach of assistive technology, so a query has to say it means to look in it. */
const HIDDEN = { includeHiddenElements: true };

const regionsAt = (sites: readonly number[]) => sites.map((site) => ({ objectId: `region-${site}`, site }));
const namesAt = (sites: readonly number[]) =>
  new Map(sites.map((site) => [`region-${site}`, `Sample region ${site + 1}`]));

function props(sites: readonly number[], more: Partial<FlatPlanetProps> = {}): FlatPlanetProps {
  return {
    world,
    chart: chartWorld(world, regionsAt(sites)),
    palette,
    names: namesAt(sites),
    size,
    reducedMotion: true,
    ...more,
  };
}

/** One node of the rendered tree, as `toJSON` gives it: react-native-svg's native names, and its colours as ARGB numbers. */
interface Node {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly (Node | string)[] | null;
}
const everyNode = (node: Node | string | null | undefined, found: Node[] = []): Node[] => {
  if (node === null || node === undefined || typeof node === 'string') return found;
  found.push(node);
  for (const child of node.children ?? []) everyNode(child, found);
  return found;
};
const nodes = (): Node[] => everyNode(screen.toJSON());
const paths = (): Node[] => nodes().filter((node) => node.type === 'RNSVGPath');
/** A `#rrggbb` as react-native-svg holds it: opaque ARGB as an unsigned number. */
const argb = (hex: string): number => 0xff000000 + Number.parseInt(hex.slice(1), 16);
/** The colour of a node's fill or stroke, as the ARGB number, or undefined for none. */
const paintOf = (node: Node, key: 'fill' | 'stroke'): number | undefined =>
  (node.props[key] as { payload?: number } | null | undefined)?.payload;

const greyPaths = () =>
  paths().filter((node) => paintOf(node, 'fill') === argb(grey) && paintOf(node, 'stroke') === argb(grey));
/** The names written on the drawing: the letters of the filled (not the outline) text. */
const writtenNames = () =>
  nodes()
    .filter((node) => node.type === 'RNSVGText' && node.props.fill !== null)
    .flatMap((node) =>
      (node.children ?? []).map((child) => (typeof child === 'string' ? child : String(child.props['content']))),
    );
/** A path that answers a press: react-native-svg marks it `responsible`. */
const pressable = () => paths().filter((node) => node.props.responsible === true);

describe('the flat drawing of a planet: land not reached (D-109)', () => {
  it.each([[[0]], [[0, 1, 2, 3]], [[...Array.from({ length: 12 }, (_, site) => site)]]])(
    'draws land not reached as exactly one path, whatever has formed (%j)',
    async (sites) => {
      await render(<FlatPlanet {...props(sites)} />);
      expect(greyPaths()).toHaveLength(1);
      // It is every unreached outline, merged: the same as the chart's.
      const unreached = loopsToPath(chartWorld(world, regionsAt(sites)).unreached.flatMap((land) => land.loops));
      expect(greyPaths()[0]!.props.d).toBe(unreached);
    },
  );

  it('gives the grey path no id, name, test id or press, and no border of its own between its pieces', async () => {
    const sites = [0, 1, 2, 3];
    await render(<FlatPlanet {...props(sites, { onChoose: jest.fn() })} />);
    const [path] = greyPaths();
    for (const key of ['id', 'testID', 'name', 'accessibilityLabel', 'onPress', 'responsible', 'strokeDasharray'])
      expect(path!.props[key]).toBeUndefined();
    // Its only stroke is its own colour, so two pieces that overlap by a sliver leave no hairline hole; nothing is
    // inked along the line between pieces. (Its coast is the world's, clipped to the grey.)
    expect(paintOf(path!, 'stroke')).toBe(paintOf(path!, 'fill'));
    // No path is drawn from a single piece of unreached land, and none from an unreached piece's outline in ink.
    const pieces = chartWorld(world, regionsAt(sites)).unreached.map((land) => loopsToPath(land.loops));
    expect(paths().filter((node) => pieces.includes(String(node.props['d'])))).toHaveLength(0);
    // Nothing on the drawing carries an id of any kind.
    for (const node of nodes()) {
      expect(node.props.id).toBeUndefined();
      if (node.type !== 'View') expect(node.props.testID).toBeUndefined();
    }
  });

  it('names and presses formed regions only', async () => {
    const onChoose = jest.fn();
    const sites = [0, 1, 2, 3];
    await render(<FlatPlanet {...props(sites, { onChoose })} />);
    const spoken = writtenNames();
    expect(spoken.length).toBeGreaterThan(0);
    for (const name of spoken) expect(Array.from(namesAt(sites).values())).toContain(name);
    // No shape answers a press: one layer over the drawing works out the region from the tap's point.
    expect(pressable()).toHaveLength(0);
    expect(screen.getAllByTestId('flat-planet-press', HIDDEN)).toHaveLength(1);
    // Nothing on the drawing says anything about land that is not reached.
    expect(spoken.join(' | ')).not.toMatch(/uncharted|not reached|unreached|locked|grey|gray|left to|more to/i);
  });

  it('draws the same grey and the same one path when more regions form, so the count of pieces says nothing', async () => {
    const few = await render(<FlatPlanet {...props([0, 1])} />);
    const first = greyPaths().map((node) => paintOf(node, 'fill'));
    await few.unmount();
    await render(<FlatPlanet {...props([0, 1, 2, 3, 4, 5])} />);
    expect(greyPaths().map((node) => paintOf(node, 'fill'))).toEqual(first);
  });

  it('hides the whole drawing from assistive technology and is not a control', async () => {
    await render(<FlatPlanet {...props([0, 1])} />);
    const drawing = screen.getByTestId('flat-planet', { includeHiddenElements: true });
    expect(drawing.props['aria-hidden']).toBe(true);
    expect(drawing.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.queryAllByRole('button', { includeHiddenElements: true })).toHaveLength(0);
    // The svg is not a tab stop.
    expect(nodes().find((node) => node.type === 'RNSVGSvgView')!.props.focusable).toBe(false);
  });

  it('keeps the land of every formed region in its site’s colour, and the grey out of the palette’s land colours', async () => {
    await render(<FlatPlanet {...props([0, 1, 2, 3])} />);
    const fills = paths().map((node) => paintOf(node, 'fill'));
    for (const colour of palette.land) expect(fills).toContain(argb(colour));
    expect(palette.land.map(argb)).not.toContain(argb(grey));
  });
});

describe('you were here', () => {
  const here = () => screen.queryByTestId('flat-planet-here', { includeHiddenElements: true });

  it('marks the region with an orange dot, on the whole planet and in its own map', async () => {
    const sites = [0, 1, 2, 3];
    const whole = await render(<FlatPlanet {...props(sites, { hereId: 'region-1' })} />);
    // The dot is drawing, hidden from a screen reader with the rest: the list's row says it in words.
    expect(here()).toBeTruthy();
    // No words on the drawing: they would crowd the names.
    expect(screen.queryByText(/you were here/i, { includeHiddenElements: true })).toBeNull();
    await whole.unmount();
    const cell = chartWorld(world, regionsAt(sites)).charted[1]!;
    await render(<FlatPlanet {...props(sites, { hereId: 'region-1', focusId: 'region-1', box: cropOf(cell) })} />);
    expect(here()).toBeTruthy();
  });

  it('marks nothing when no region is, and for a region that has not formed', async () => {
    const none = await render(<FlatPlanet {...props([0, 1])} />);
    expect(here()).toBeNull();
    await none.unmount();
    await render(<FlatPlanet {...props([0, 1], { hereId: 'region-9' })} />);
    expect(here()).toBeNull();
  });
});

describe('a region’s own map', () => {
  it('writes no names, fades the other regions and keeps the grey one path in each turn of the band', async () => {
    const sites = [0, 1, 2, seamSite];
    const chart = chartWorld(world, regionsAt(sites));
    const cell = chart.charted.find((candidate) => candidate.site === seamSite)!;
    const box = cropOf(cell);
    await render(<FlatPlanet {...props(sites, { focusId: `region-${seamSite}`, box })} />);
    expect(writtenNames()).toEqual([]);
    expect(greyPaths()).toHaveLength(copiesOf(box).length);
    expect(copiesOf(box).length).toBeGreaterThan(1);
    // The other three are inside a faded group, in every turn; the region itself is not.
    expect(nodes().filter((node) => node.type === 'RNSVGGroup' && node.props.opacity === 0.4)).toHaveLength(
      copiesOf(box).length,
    );
    // Nothing is pressable in a region's own map.
    expect(pressable()).toHaveLength(0);
    expect(screen.queryByTestId('flat-planet-press', HIDDEN)).toBeNull();
  });

  it('draws the whole band once when it is not cropped', async () => {
    await render(<FlatPlanet {...props([0, 1, 2, 3], { box: WHOLE_BAND })} />);
    expect(greyPaths()).toHaveLength(1);
  });
});

describe('choosing a region by a tap on the flat drawing', () => {
  const sites = [0, 2, 3, 5];
  /** A press at a point of the band on the whole-band drawing, as the press layer reports it. */
  const pressAtBand = (x: number, y: number) =>
    fireEvent(screen.getByTestId('flat-planet-press', HIDDEN), 'responderRelease', {
      nativeEvent: { locationX: (x * size.width) / WHOLE_BAND.width, locationY: (y * size.height) / WHOLE_BAND.height },
    });

  it('chooses the region whose land is tapped, and nothing for the sea or land not reached', async () => {
    const onChoose = jest.fn();
    const chart = chartWorld(world, regionsAt(sites));
    await render(<FlatPlanet {...props(sites, { onChoose })} />);
    for (const cell of chart.charted) {
      onChoose.mockClear();
      const at = centreOfCell(cell, BAND_WIDTH);
      await pressAtBand(at.x, at.y);
      expect(onChoose).toHaveBeenCalledTimes(1);
      expect(onChoose).toHaveBeenCalledWith(cell.objectId);
    }
    onChoose.mockClear();
    // A corner of the band is open sea, far from any formed region.
    await pressAtBand(1, 1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('chooses nothing from a press that carries no point', async () => {
    const onChoose = jest.fn();
    await render(<FlatPlanet {...props(sites, { onChoose })} />);
    await fireEvent(screen.getByTestId('flat-planet-press', HIDDEN), 'responderRelease', { nativeEvent: {} });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('is not focusable at all and has no name or role of its own', async () => {
    await render(<FlatPlanet {...props(sites, { onChoose: jest.fn() })} />);
    const layer = screen.getByTestId('flat-planet-press', HIDDEN);
    expect(layer.props.tabIndex).toBeUndefined();
    expect(layer.props.accessibilityRole).toBeUndefined();
    expect(layer.props.accessibilityLabel).toBeUndefined();
  });
});
