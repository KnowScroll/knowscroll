import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { renderOn } from '../test-support/render';
import { PullDownSheet } from './pull-down-sheet';

describe('PullDownSheet', () => {
  it('is a dialog named by its title while visible, and nothing while hidden', async () => {
    const view = await renderOn(
      <PullDownSheet visible title="A series · 3 parts" top={72} onClose={() => undefined}>
        <Text>Part 1</Text>
      </PullDownSheet>,
    );
    expect(screen.getByLabelText('A series · 3 parts')).toHaveProp('role', 'dialog');
    expect(screen.getByText('Part 1')).toBeOnTheScreen();

    await view.rerender(
      <PullDownSheet visible={false} title="A series · 3 parts" top={72} onClose={() => undefined}>
        <Text>Part 1</Text>
      </PullDownSheet>,
    );
    expect(screen.queryByLabelText('A series · 3 parts')).toBeNull();
  });

  it('hangs from the header it was pulled from and leaves it out of the dimmed part', async () => {
    await renderOn(<PullDownSheet visible title="Series" top={96} onClose={() => undefined} testID="sheet" />);
    expect(screen.getByTestId('sheet')).toHaveStyle({ top: 96 });
  });

  it('closes from Close, the scrim and the platform back (it is not a route)', async () => {
    const onClose = jest.fn();
    await renderOn(<PullDownSheet visible title="Series" top={72} onClose={onClose} testID="sheet" />);
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.press(screen.getByTestId('sheet-scrim', { includeHiddenElements: true }));
    await fireEvent(screen.getByTestId('sheet-modal'), 'requestClose');
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('does not travel under reduced motion: it only fades in', async () => {
    await renderOn(<PullDownSheet visible title="Series" top={72} onClose={() => undefined} testID="sheet" />, {
      reducedMotion: true,
    });
    expect(screen.getByTestId('sheet')).toHaveStyle({ transform: [{ translateY: 0 }] });
  });
});
