import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RequestsList } from './requests-list';
import { closedItem, preparing, readyItem, requestsListHarness } from './requests-list.fixture';
import { id } from '../encounter/encounter-session.fixture';

const frame = (node: React.ReactNode) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 800 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    }}
  >
    <DisplayProvider value={{ width: 390, textScale: 1 }}>{node}</DisplayProvider>
  </SafeAreaProvider>
);

describe('E07 requests list', () => {
  it('shows each ask with one honest state and the one action it has', async () => {
    const h = requestsListHarness([
      readyItem(11),
      preparing(10, 'Football tactics'),
      closedItem(12, 'unsupported_request'),
    ]);
    const open = jest.fn();
    const screen = await render(frame(<RequestsList session={h.session} onOpen={open} />));
    try {
      h.session.visible(true);
      await waitFor(() => expect(screen.getAllByTestId('request-row')).toHaveLength(3));
      expect(screen.getByText('Football tactics, as a Scroll')).toBeTruthy();
      expect(screen.getByLabelText('Preparing')).toBeTruthy();
      expect(screen.getByText(/We can't make that one right now/)).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Ready · Open' }));
      expect(open).toHaveBeenCalledWith({ kind: 'scroll', assetId: id(511) });
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel request' }));
      await waitFor(() => expect(h.cancels()).toHaveLength(1));
      await waitFor(() => expect(screen.queryByLabelText('Preparing')).toBeNull());
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('opens a ready Reel as a Reel', async () => {
    const h = requestsListHarness([readyItem(13, 'reel')]);
    const open = jest.fn();
    const screen = await render(frame(<RequestsList session={h.session} onOpen={open} />));
    try {
      h.session.visible(true);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Ready · Open' })).toBeTruthy());
      await fireEvent.press(screen.getByRole('button', { name: 'Ready · Open' }));
      expect(open).toHaveBeenCalledWith({ kind: 'reel', assetId: id(513) });
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it("says couldn't prepare with Ask differently, and offers nothing for what can't be made", async () => {
    const h = requestsListHarness([
      closedItem(20, 'could_not_prepare'),
      closedItem(21, 'unsupported_request'),
      closedItem(22, 'budget_unavailable'),
    ]);
    const onAsk = jest.fn();
    const screen = await render(frame(<RequestsList session={h.session} onOpen={jest.fn()} onAsk={onAsk} />));
    try {
      h.session.visible(true);
      await waitFor(() => expect(screen.getAllByTestId('request-row')).toHaveLength(3));
      expect(screen.getByLabelText("Couldn't prepare")).toBeTruthy();
      expect(screen.getAllByLabelText("Can't be made")).toHaveLength(2);
      expect(screen.queryByRole('button', { name: /Retry|Try again/ })).toBeNull();
      expect(screen.getAllByRole('button', { name: 'Ask differently' })).toHaveLength(1);
      await fireEvent.press(screen.getByRole('button', { name: 'Ask differently' }));
      expect(onAsk).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('says so when nothing was asked, and when the list could not be read or is stale', async () => {
    const empty = requestsListHarness([]);
    const onAsk = jest.fn();
    const first = await render(frame(<RequestsList session={empty.session} onOpen={jest.fn()} onAsk={onAsk} />));
    try {
      empty.session.visible(true);
      await waitFor(() => expect(first.getByText('Nothing requested yet')).toBeTruthy());
      await fireEvent.press(first.getByRole('link', { name: 'Go to Explore' }));
      expect(onAsk).toHaveBeenCalled();
    } finally {
      await first.unmount();
      await act(() => empty.scope.end());
    }

    const stale = requestsListHarness([preparing(10)]);
    const second = await render(frame(<RequestsList session={stale.session} onOpen={jest.fn()} />));
    try {
      stale.session.visible(true);
      await waitFor(() => expect(second.getAllByTestId('request-row')).toHaveLength(1));
      stale.setListFailure(true);
      await act(() => stale.session.refresh());
      expect(second.getByText(/May be out of date/)).toBeTruthy();
      expect(second.getAllByTestId('request-row')).toHaveLength(1);
    } finally {
      await second.unmount();
      await act(() => stale.scope.end());
    }
  });
});
