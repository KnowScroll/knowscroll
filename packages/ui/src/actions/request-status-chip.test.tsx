import { fireEvent, screen } from '@testing-library/react-native';
import { renderOn } from '../test-support/render';
import { RequestStatusChip } from './request-status-chip';

describe('RequestStatusChip', () => {
  it('announces waiting states as a status, word first, with no percentage or time', async () => {
    await renderOn(
      <>
        <RequestStatusChip status="requested" detail="Scroll of this Reel" />
        <RequestStatusChip status="preparing" detail="we'll let you know" />
      </>,
    );
    expect(screen.getByRole('status', { name: 'Requested · Scroll of this Reel' })).toBeOnTheScreen();
    expect(screen.getByRole('status', { name: "Preparing · we'll let you know" })).toBeOnTheScreen();
    expect(screen.queryByText(/%|\bmin\b|ETA/)).toBeNull();
  });

  it('becomes a button when ready or failed and an action exists', async () => {
    const open = jest.fn();
    const retry = jest.fn();
    await renderOn(
      <>
        <RequestStatusChip status="ready" detail="Open Scroll" onPress={open} />
        <RequestStatusChip status="failed" detail="Retry" onPress={retry} />
      </>,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Ready · Open Scroll' }));
    await fireEvent.press(screen.getByRole('button', { name: "Couldn't prepare · Retry" }));

    expect(open).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is not a button while waiting, even with a handler', async () => {
    await renderOn(<RequestStatusChip status="preparing" onPress={() => undefined} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws cancelled with a dashed edge', async () => {
    await renderOn(<RequestStatusChip status="cancelled" testID="chip" />);
    expect(screen.getByTestId('chip')).toHaveStyle({ borderStyle: 'dashed' });
  });

  it('keeps a 44 px target', async () => {
    await renderOn(<RequestStatusChip status="ready" detail="Open Scroll" onPress={() => undefined} />);
    expect(screen.getByRole('button')).toHaveStyle({ minHeight: 44 });
  });
});
