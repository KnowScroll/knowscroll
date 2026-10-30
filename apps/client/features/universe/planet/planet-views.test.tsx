import { render, screen, fireEvent } from '@testing-library/react-native';
import { buildGlobe, buildMap, chartWorld, type WorldSpec } from '@knowscroll/scene-core';
import { paletteOf } from './planet-palette';
import { PlanetGlobe } from './planet-globe';
import { PlanetMap } from './planet-map';

jest.mock('expo-router', () => ({ useIsFocused: () => true }));

const spec: WorldSpec = { seed: '0123456789abcdef0123456789abcdef', type: 'lush', variant: 0, siteCount: 7 };
const regions = [
  { objectId: 'region-a', site: 0 },
  { objectId: 'region-b', site: 1 },
  { objectId: 'region-c', site: 2 },
];
const names = new Map([
  ['region-a', 'Alpha'],
  ['region-b', 'Beta'],
  ['region-c', 'Gamma'],
]);
const size = { width: 390, height: 844 };
const palette = paletteOf('lush', 0);
const map = buildMap(spec);
const globe = buildGlobe(spec);

function mapProps(
  overrides: Partial<React.ComponentProps<typeof PlanetMap>> = {},
): React.ComponentProps<typeof PlanetMap> {
  return {
    world: map,
    chart: chartWorld(map, regions),
    palette,
    names,
    accessibleNames: new Map(
      [...names].map(([id, name]) => [id, id === 'region-b' ? `${name} · you were here` : name]),
    ),
    size,
    frame: { x: 0, y: 0, scale: 1 },
    selectedId: undefined,
    hereId: undefined,
    reducedMotion: true,
    onChoose: jest.fn(),
    ...overrides,
  };
}

describe('the landed map (U04)', () => {
  it('gives each formed region one named target and nothing else to choose, whatever land is grey', async () => {
    await render(<PlanetMap {...mapProps()} />);
    const targets = screen.getAllByRole('button');
    expect(targets).toHaveLength(3);
    expect(targets.map((target) => String(target.props.accessibilityLabel))).toEqual([
      'Alpha, a region',
      'Beta · you were here, a region',
      'Gamma, a region',
    ]);
    // The drawing, grey and all, is hidden from assistive technology.
    expect(screen.queryAllByText(/./)).toHaveLength(0);
    expect(screen.queryAllByRole('image')).toHaveLength(0);
  });

  it('chooses a region by its target, and not when the camera has only just been dragged', async () => {
    const onChoose = jest.fn();
    const view = await render(<PlanetMap {...mapProps({ onChoose })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Alpha, a region' }));
    expect(onChoose).toHaveBeenCalledWith('region-a');
    onChoose.mockClear();
    // A drag pans the camera; the click the browser sends when the pointer is let go is not a choice.
    await view.rerender(<PlanetMap {...mapProps({ onChoose, frame: { x: 40, y: 0, scale: 1 } })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Alpha, a region' }));
    expect(onChoose).not.toHaveBeenCalled();
    jest.useFakeTimers({ now: Date.now() + 1000, doNotFake: ['nextTick', 'setImmediate'] });
    await fireEvent.press(screen.getByRole('button', { name: 'Alpha, a region' }));
    jest.useRealTimers();
    expect(onChoose).toHaveBeenCalledWith('region-a');
  });

  it('marks the chosen region as selected and the region left through its card as where the person was', async () => {
    await render(<PlanetMap {...mapProps({ selectedId: 'region-c' })} />);
    expect(screen.getByRole('button', { name: 'Gamma, a region' }).props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(screen.getByRole('button', { name: 'Alpha, a region' }).props.accessibilityState).toMatchObject({
      selected: false,
    });
    await screen.unmount();
    await render(<PlanetMap {...mapProps({ hereId: 'region-b' })} />);
    expect(screen.getAllByText('Beta · you were here', { includeHiddenElements: true }).length).toBeGreaterThan(0);
  });

  it('says a region is hypothetical to a screen reader', async () => {
    await render(<PlanetMap {...mapProps({ hypothetical: new Set(['region-a']) })} />);
    expect(screen.getByRole('button', { name: 'Alpha, a region, hypothetical' })).toBeOnTheScreen();
  });
});

describe('the globe (U03)', () => {
  const globeProps = (
    overrides: Partial<React.ComponentProps<typeof PlanetGlobe>> = {},
  ): React.ComponentProps<typeof PlanetGlobe> => ({
    world: globe,
    chart: chartWorld(globe, regions),
    palette,
    labels: names,
    size,
    dragX: 0,
    reducedMotion: true,
    rings: true,
    moon: true,
    onLand: jest.fn(),
    landLabel: 'Land on Test planet',
    ...overrides,
  });

  it('has one control, to land, and its drawing, names and rings are hidden from assistive technology', async () => {
    await render(<PlanetGlobe {...globeProps()} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Land on Test planet' })).toBeOnTheScreen();
    expect(screen.queryAllByText(/./)).toHaveLength(0);
  });

  it('lands on a tap and not on the end of a drag', async () => {
    const onLand = jest.fn();
    const view = await render(<PlanetGlobe {...globeProps({ onLand })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Land on Test planet' }));
    expect(onLand).toHaveBeenCalledTimes(1);
    await view.rerender(<PlanetGlobe {...globeProps({ onLand, dragX: -60 })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Land on Test planet' }));
    expect(onLand).toHaveBeenCalledTimes(1);
  });

  it('offers no way to land where landing is not offered, and draws without a ring or a moon', async () => {
    await render(<PlanetGlobe {...globeProps({ onLand: undefined, rings: false, moon: false })} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
