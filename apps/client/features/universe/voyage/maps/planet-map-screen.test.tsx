import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { mapsFixture } from '../../../gallery/maps-gallery-fixtures';
import { readMapsParams } from '../../../gallery/maps-gallery-params';
import { PlanetMapScreen, type PlanetMapScreenProps } from './planet-map-screen';

const fixtureFor = (query: Record<string, string> = {}) => mapsFixture(readMapsParams(query));

function props(query: Record<string, string> = {}, more: Partial<PlanetMapScreenProps> = {}): PlanetMapScreenProps {
  const fixture = fixtureFor(query);
  return {
    // Each test is its own session, so no world is kept from the one before.
    session: {},
    planet: fixture.planet,
    systemLabel: fixture.systemLabel,
    regions: fixture.regions,
    looks: fixture.looks,
    hereId: fixture.hereId,
    onBack: jest.fn(),
    onChooseRegion: jest.fn(),
    ...more,
  };
}

/** The least height a style gives, through the arrays and falsy entries a style can be. */
const minHeightOf = (style: unknown): number => {
  if (Array.isArray(style)) return Math.max(0, ...style.map((entry: unknown) => minHeightOf(entry)));
  if (style !== null && typeof style === 'object') return Number((style as { minHeight?: number }).minHeight ?? 0);
  return 0;
};

const ready = () =>
  waitFor(() => expect(screen.getByTestId('flat-planet', { includeHiddenElements: true })).toBeTruthy());

/** Every string a screen draws, hidden or not: what a tree could ever say, whether or not a screen reader hears it. */
function allStrings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') found.push(node);
  else if (Array.isArray(node)) for (const child of node) allStrings(child, found);
  else if (node && typeof node === 'object') {
    const element = node as { children?: unknown; props?: { content?: unknown; accessibilityLabel?: unknown } };
    // react-native-svg keeps the letters of a Text in its `content` prop.
    if (typeof element.props?.content === 'string') found.push(element.props.content);
    if (typeof element.props?.accessibilityLabel === 'string') found.push(element.props.accessibilityLabel);
    allStrings(element.children, found);
  }
  return found;
}

const regionButtons = () => screen.getAllByRole('button', { name: /, a region/ });

describe('map 1: the whole planet', () => {
  it('says what the screen is: the title, the planet’s system and the way back, named for where it goes', async () => {
    await render(<PlanetMapScreen {...props()} />);
    expect(screen.getByRole('header', { name: 'Map of Sample planet' })).toBeOnTheScreen();
    expect(screen.getByText('A planet in Sample system')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Sample planet' })).toBeOnTheScreen();
    const dialog = screen.getByTestId('map-screen');
    expect(dialog.props.role).toBe('dialog');
    expect(dialog.props['aria-modal']).toBe(true);
    expect(dialog.props.accessibilityLabel).toBe('Map of Sample planet');
    await ready();
  });

  it('lists the formed regions in map order, named as a region’s button is on the map, and counts only those', async () => {
    await render(<PlanetMapScreen {...props({ regions: '4' })} />);
    // The list is there on the first render, before the world is built.
    expect(regionButtons().map((button) => String(button.props.accessibilityLabel))).toEqual([
      'Sample region 1, a region',
      'Sample region 2, a region',
      'Sample region 3, a region',
      'Sample region 4, a region',
    ]);
    expect(screen.getByText('4 regions')).toBeOnTheScreen();
    await ready();
    // The drawing is not a control: the same four buttons, no more.
    expect(regionButtons()).toHaveLength(4);
  });

  it('counts one region as "1 region", and never as a part of something', async () => {
    await render(<PlanetMapScreen {...props({ regions: '1' })} />);
    expect(screen.getByText('1 region')).toBeOnTheScreen();
    await ready();
  });

  it('says nothing, anywhere on the screen, about land that is not reached, however many have formed', async () => {
    for (const regions of ['1', '4', '12']) {
      const view = await render(<PlanetMapScreen {...props({ regions, seam: '1' })} />);
      await ready();
      const said = allStrings(screen.toJSON()).join(' | ');
      expect(said).not.toMatch(
        /uncharted|not reached|unreached|locked|grey|gray|left to|more to|under cloud| of \d+|mastery|level|score/i,
      );
      // The only region names on the screen are the formed ones.
      const named = new Set(said.match(/Sample region \d+/g));
      expect(named.size).toBeLessThanOrEqual(Number(regions));
      expect(Math.max(...Array.from(named, (name) => Number(name.slice('Sample region '.length))))).toBeLessThanOrEqual(
        Number(regions),
      );
      await view.unmount();
    }
  });

  it('marks the region you were here in its row, in words', async () => {
    await render(<PlanetMapScreen {...props({ here: '1' })} />);
    expect(screen.getByRole('button', { name: 'Sample region 2, a region, you were here' })).toBeOnTheScreen();
    expect(screen.getByText('You were here')).toBeOnTheScreen();
    await ready();
  });

  it('says a hypothetical region is, as a region’s button does', async () => {
    const fixture = fixtureFor();
    const regions = fixture.regions.map((region, at) =>
      at === 0 ? { ...region, truthStatus: 'hypothetical' as const } : region,
    );
    await render(<PlanetMapScreen {...props({}, { regions })} />);
    expect(screen.getByRole('button', { name: 'Sample region 1, a region, hypothetical' })).toBeOnTheScreen();
    await ready();
  });

  it('chooses a region from its row, and goes back', async () => {
    const onChooseRegion = jest.fn();
    const onBack = jest.fn();
    await render(<PlanetMapScreen {...props({}, { onChooseRegion, onBack })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sample region 3, a region' }));
    expect(onChooseRegion).toHaveBeenCalledWith(fixtureFor().regions[2]!.objectId);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Sample planet' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await ready();
  });

  it('has no control smaller than 48 points', async () => {
    await render(<PlanetMapScreen {...props()} />);
    const small = [...regionButtons(), screen.getByRole('button', { name: /^Back to/ })].filter((button) => {
      return minHeightOf(button.props.style) < 48;
    });
    expect(small).toHaveLength(0);
    await ready();
  });

  it('draws the world after the first frame, and shows the list meanwhile', async () => {
    // The world is built in a timer so the first frame is not held: hold the timer to see the frame before it.
    jest.useFakeTimers();
    try {
      await render(<PlanetMapScreen {...props()} />);
      expect(screen.getByTestId('map-waiting')).toBeOnTheScreen();
      expect(screen.getByText('Drawing the map…')).toBeOnTheScreen();
      expect(regionButtons()).toHaveLength(4);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5);
      });
      expect(screen.queryByTestId('map-waiting')).toBeNull();
      expect(screen.getByTestId('flat-planet', { includeHiddenElements: true })).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hides the drawing from a screen reader and leaves only the list and the way back in the tree', async () => {
    await render(
      <DisplayProvider value={{ reducedMotion: true }}>
        <PlanetMapScreen {...props({ regions: '4', here: '1' })} />
      </DisplayProvider>,
    );
    await ready();
    expect(screen.queryByTestId('flat-planet')).toBeNull();
    expect(screen.getAllByRole('button').map((button) => String(button.props.accessibilityLabel ?? ''))).toEqual([
      'Back to Sample planet',
      'Sample region 1, a region',
      'Sample region 2, a region, you were here',
      'Sample region 3, a region',
      'Sample region 4, a region',
    ]);
  });
});
