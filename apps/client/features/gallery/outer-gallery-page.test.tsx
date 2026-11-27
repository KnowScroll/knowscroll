import { fireEvent, render, screen } from '@testing-library/react-native';
import { OuterGalleryPage } from './outer-gallery-page';

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
}));

const hidden = { includeHiddenElements: true } as const;
beforeEach(() => {
  mockParams = {};
});

describe('the outer gallery page', () => {
  it('draws the layer over the sample sky with the title, the line and at most ten friend buttons', async () => {
    mockParams = { friends: '40' };
    await render(<OuterGalleryPage />);
    expect(screen.getByText('Beyond your universe')).toBeOnTheScreen();
    expect(screen.getByTestId('outer-line').props.children).toBe('40 friends');
    const buttons = screen
      .getAllByRole('button')
      .filter((button) => String(button.props.testID).startsWith('outer-friend-'));
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    expect(buttons.length).toBeLessThanOrEqual(10);
    expect(screen.getByRole('button', { name: 'All friends (40)' })).toBeOnTheScreen();
  });

  it('says who a tap would cross to, and goes nowhere', async () => {
    mockParams = { friends: '3' };
    await render(<OuterGalleryPage />);
    await fireEvent.press(screen.getByRole('button', { name: 'Ravi’s universe' }));
    expect(screen.getByTestId('ks-outer-last', hidden).props.accessibilityLabel).toBe('Cross to ravi');
  });

  it('opens the list of every friend from the chip, or from the address', async () => {
    mockParams = { friends: '14' };
    await render(<OuterGalleryPage />);
    await fireEvent.press(screen.getByRole('button', { name: 'All friends (14)' }));
    expect(screen.getByTestId('outer-friends-list')).toBeOnTheScreen();
    expect(
      screen.getAllByRole('button').filter((button) => String(button.props.testID).startsWith('outer-row-')),
    ).toHaveLength(14);
    await screen.unmount();
    mockParams = { friends: '3', list: '1' };
    await render(<OuterGalleryPage />);
    expect(screen.getByTestId('outer-friends-list')).toBeOnTheScreen();
  });

  it('shows no friend buttons when asked, and holds a far pan inside the field', async () => {
    mockParams = { friends: '14', buttons: '0', panx: '9000', pany: '9000' };
    await render(<OuterGalleryPage />);
    expect(
      screen.getAllByRole('button').filter((button) => String(button.props.testID).startsWith('outer-friend-')),
    ).toHaveLength(0);
    expect(screen.getByText('Beyond your universe')).toBeOnTheScreen();
  });
});
