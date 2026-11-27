import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { MapsGalleryPage } from './maps-gallery-page';

let mockParams: Record<string, string> = {};
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ navigate: mockNavigate }),
}));

const ready = () =>
  waitFor(() => expect(screen.getByTestId('flat-planet', { includeHiddenElements: true })).toBeTruthy());

beforeEach(() => {
  mockParams = {};
  mockNavigate.mockClear();
});

describe('the maps gallery page', () => {
  it('opens map 1 by default, and walks to a region’s map and back', async () => {
    await render(<MapsGalleryPage />);
    expect(screen.getByRole('header', { name: 'Map of Sample planet' })).toBeOnTheScreen();
    await ready();
    await fireEvent.press(screen.getByRole('button', { name: 'Sample region 2, a region' }));
    expect(screen.getByRole('header', { name: 'Sample region 2' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Back to Map of Sample planet' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Map of Sample planet' }));
    expect(screen.getByRole('header', { name: 'Map of Sample planet' })).toBeOnTheScreen();
    await ready();
  });

  it('opens map 2 straight from the address, with its preview', async () => {
    mockParams = { map: '2', preview: 'reel' };
    await render(<MapsGalleryPage />);
    expect(screen.getByRole('header', { name: 'Sample region 1' })).toBeOnTheScreen();
    expect(screen.getByText('A Reel')).toBeOnTheScreen();
    await ready();
  });

  it('never leaves the page: Open goes nowhere, and a blocked preview refuses it', async () => {
    mockParams = { map: '2' };
    await render(<MapsGalleryPage />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open' }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('ks-maps-last', { includeHiddenElements: true }).props.accessibilityLabel).toBe(
      'Open encounter',
    );
    await ready();
  });

  it('shows the blocked state after Open when the preview is blocked', async () => {
    mockParams = { map: '2', preview: 'blocked' };
    await render(<MapsGalleryPage />);
    await fireEvent.press(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Return to encounter' })).toBeOnTheScreen();
    expect(mockNavigate).not.toHaveBeenCalled();
    await ready();
  });
});
