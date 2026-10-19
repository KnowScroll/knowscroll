import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { renderOn } from '../test-support/render';
import { BottomSheet } from './bottom-sheet';

describe('BottomSheet', () => {
  it('is a dialog named by its title while visible, and nothing while hidden', async () => {
    const view = await renderOn(
      <BottomSheet visible title="Share" onClose={() => undefined}>
        <Text>Send to a conversation</Text>
      </BottomSheet>,
    );
    expect(screen.getByLabelText('Share')).toHaveProp('role', 'dialog');
    expect(screen.getByLabelText('Share')).toHaveProp('accessibilityViewIsModal', true);
    expect(screen.getByRole('header', { name: 'Share' })).toBeOnTheScreen();
    expect(screen.getByText('Send to a conversation')).toBeOnTheScreen();

    await view.rerender(
      <BottomSheet visible={false} title="Share" onClose={() => undefined}>
        <Text>Send to a conversation</Text>
      </BottomSheet>,
    );
    expect(screen.queryByLabelText('Share')).toBeNull();
  });

  it('closes from its Close button, the scrim and the platform back (it is not a route)', async () => {
    const onClose = jest.fn();
    await renderOn(<BottomSheet visible title="Share" onClose={onClose} testID="sheet" />);

    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    // The sheet is the modal view, so assistive technology does not see its siblings, the scrim
    // included; a pointer still reaches it.
    await fireEvent.press(screen.getByTestId('sheet-scrim', { includeHiddenElements: true }));
    await fireEvent(screen.getByTestId('sheet-modal'), 'requestClose');

    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('keeps the scrim out of the accessibility tree (Close, Back and Esc do the same)', async () => {
    await renderOn(<BottomSheet visible title="Share" onClose={() => undefined} testID="sheet" />);
    expect(screen.queryByTestId('sheet-scrim')).toBeNull();
    expect(screen.getByTestId('sheet-scrim', { includeHiddenElements: true })).toHaveProp('accessible', false);
  });

  it('does not travel under reduced motion: it only fades in', async () => {
    await renderOn(<BottomSheet visible title="Share" onClose={() => undefined} testID="sheet" />, {
      reducedMotion: true,
    });
    expect(screen.getByTestId('sheet')).toHaveStyle({ transform: [{ translateY: 0 }] });
  });
});
