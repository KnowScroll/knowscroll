import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { mapsFixture, previewOf } from '../../../gallery/maps-gallery-fixtures';
import { readMapsParams, type MapsPreviewKind } from '../../../gallery/maps-gallery-params';
import { RegionMapScreen, type RegionMapScreenProps } from './region-map-screen';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: mockNavigate }) }));

function props(
  query: Record<string, string> = {},
  preview: MapsPreviewKind = 'scroll',
  more: Partial<RegionMapScreenProps> = {},
): RegionMapScreenProps {
  const fixture = mapsFixture(readMapsParams({ map: '2', ...query }));
  return {
    session: {},
    planet: fixture.planet,
    regions: fixture.regions,
    looks: fixture.looks,
    region: fixture.regions.find((region) => region.objectId === fixture.shownId)!,
    hereId: fixture.hereId,
    preview: previewOf(preview),
    cameFromMap: false,
    onBack: jest.fn(),
    onRefreshPreview: jest.fn(),
    onOpen: jest.fn(() => true),
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

/** Every string a screen draws, hidden or not. */
function allStrings(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') found.push(node);
  else if (Array.isArray(node)) for (const child of node) allStrings(child, found);
  else if (node && typeof node === 'object') {
    const element = node as { children?: unknown; props?: { content?: unknown; accessibilityLabel?: unknown } };
    if (typeof element.props?.content === 'string') found.push(element.props.content);
    if (typeof element.props?.accessibilityLabel === 'string') found.push(element.props.accessibilityLabel);
    allStrings(element.children, found);
  }
  return found;
}

beforeEach(() => mockNavigate.mockClear());

describe('map 2: one region’s own map', () => {
  it('says whose region it is: the planet in the small line, the region as the title, and the way back by name', async () => {
    await render(<RegionMapScreen {...props()} />);
    expect(screen.getByText('A region of Sample planet')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Sample region 1' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Sample planet' })).toBeOnTheScreen();
    await ready();
  });

  it('names Back for the map it came from, and calls the one onBack', async () => {
    const onBack = jest.fn();
    await render(<RegionMapScreen {...props({}, 'scroll', { cameFromMap: true, onBack })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Map of Sample planet' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await ready();
  });

  it('says "Hypothetical" when the region is', async () => {
    const base = props();
    await render(<RegionMapScreen {...base} region={{ ...base.region, truthStatus: 'hypothetical' }} />);
    expect(screen.getByLabelText('Hypothetical')).toBeOnTheScreen();
    await ready();
  });

  it('draws the region’s own crop only after the world is built, and says nothing about land that is not reached', async () => {
    const queries: Record<string, string>[] = [{}, { seam: '1', regions: '12', here: '1' }];
    for (const query of queries) {
      const view = await render(<RegionMapScreen {...props(query)} />);
      await ready();
      const said = allStrings(screen.toJSON()).join(' | ');
      expect(said).not.toMatch(
        /uncharted|not reached|unreached|locked|grey|gray|left to|more to|under cloud| of \d+|mastery|level|score/i,
      );
      // The only names written anywhere are this region's (the others are faded and unnamed).
      expect(new Set(said.match(/Sample region \d+/g)).size).toBeLessThanOrEqual(1);
      await view.unmount();
    }
  });

  it('lists no other region, and has no row for one', async () => {
    await render(<RegionMapScreen {...props({ regions: '12' })} />);
    await ready();
    expect(screen.queryAllByRole('button', { name: /, a region/ })).toHaveLength(0);
  });
});

describe('Open and the preview', () => {
  it('shows the next Scroll with its Reel twin, each with its own button', async () => {
    await render(<RegionMapScreen {...props()} />);
    expect(screen.getByText('Next from here')).toBeOnTheScreen();
    expect(screen.getByText('A Scroll')).toBeOnTheScreen();
    expect(screen.getByText('Sample Scroll: how a small idea grows')).toBeOnTheScreen();
    expect(screen.getByText(/A short sample explanation/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Open' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Watch as a Reel' })).toBeOnTheScreen();
    await ready();
  });

  it('shows a Reel first with a Scroll twin when the server leans to Reels', async () => {
    await render(<RegionMapScreen {...props({}, 'reel')} />);
    expect(screen.getByText('A Reel')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Read as a Scroll' })).toBeOnTheScreen();
    await ready();
  });

  it('opens the encounter, then the encounter route; leaving it by Back lands on the Universe', async () => {
    const config = props();
    await render(<RegionMapScreen {...config} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open' }));
    expect(config.onOpen).toHaveBeenCalledWith(config.preview.preview, expect.any(Function), 'encounter');
    expect(mockNavigate).toHaveBeenCalledWith('/explore');
    // `onReturn` is what the session calls when the person leaves the encounter by Back.
    jest.mocked(config.onOpen).mock.calls[0]![1]();
    expect(mockNavigate).toHaveBeenLastCalledWith('/universe');
    await ready();
  });

  it('opens the other format exactly when its button is pressed', async () => {
    const config = props();
    await render(<RegionMapScreen {...config} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Watch as a Reel' }));
    expect(config.onOpen).toHaveBeenCalledWith(config.preview.preview, expect.any(Function), 'alternate');
    expect(mockNavigate).toHaveBeenCalledWith('/explore');
    await ready();
  });

  it('goes where the page says when it is given somewhere to go (the gallery)', async () => {
    const navigate = jest.fn();
    await render(<RegionMapScreen {...props({}, 'scroll', { navigate })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open' }));
    expect(navigate).toHaveBeenCalledWith('/explore');
    expect(mockNavigate).not.toHaveBeenCalled();
    await ready();
  });

  it('is blocked when the session refuses: it says so and offers to return, and does not leave', async () => {
    await render(<RegionMapScreen {...props({}, 'scroll', { onOpen: jest.fn(() => false) })} />);
    expect(screen.queryByText(/earlier encounter needs attention/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open' }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(
      screen.getByText('An earlier encounter needs attention. Return to it before choosing another.'),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Return to encounter' }));
    expect(mockNavigate).toHaveBeenCalledWith('/explore');
    await ready();
  });

  it('asks the session to read the preview again when the person tries again', async () => {
    const onRefreshPreview = jest.fn();
    await render(<RegionMapScreen {...props({}, 'unavailable', { onRefreshPreview })} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRefreshPreview).toHaveBeenCalledTimes(1);
    await ready();
  });

  it('says it is finding an encounter while loading, with nothing to press', async () => {
    await render(<RegionMapScreen {...props({}, 'loading')} />);
    expect(screen.getByText('Finding an encounter from this region…')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await ready();
  });

  it('says it opens when back online, keeps the place and offers to try again', async () => {
    const onRefreshPreview = jest.fn();
    await render(<RegionMapScreen {...props({}, 'offline', { onRefreshPreview })} />);
    expect(screen.getByText('Opens when you’re back online. This place is kept.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRefreshPreview).toHaveBeenCalledTimes(1);
    await ready();
  });

  it('says encounters are not available yet, without saying why or what else is closed', async () => {
    await render(<RegionMapScreen {...props({}, 'unavailable')} />);
    expect(screen.getByText('Encounters from this region aren’t available yet.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
    await ready();
  });

  it('has no control smaller than 48 points', async () => {
    await render(<RegionMapScreen {...props()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    const small = buttons.filter((button) => {
      return minHeightOf(button.props.style) < 48;
    });
    expect(small).toHaveLength(0);
    await ready();
  });
});
