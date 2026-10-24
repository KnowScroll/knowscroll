import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { EncounterOverlay } from '../encounter/encounter-overlay';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DisplayProvider } from '@knowscroll/ui';
import { RequestPanel } from './request-panel';
import { requestHarness } from './request-session.fixture';

describe('E04 request panel', () => {
  it('provides labelled input and explicit choices under the 320px/200% display configuration', async () => {
    const h = requestHarness();
    const close = jest.fn();
    const screen = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 320, height: 640 },
          insets: { top: 0, bottom: 0, left: 0, right: 0 },
        }}
      >
        <DisplayProvider value={{ width: 320, textScale: 2 }}>
          <EncounterOverlay label="Ask for something" presentation="sheet" onClose={close}>
            <RequestPanel session={h.session} onClose={close} />
          </EncounterOverlay>
        </DisplayProvider>
      </SafeAreaProvider>,
    );
    try {
      expect(screen.getByLabelText('Ask for something')).toHaveProp('role', 'dialog');
      expect(screen.getByLabelText('Ask for something')).toHaveProp('accessibilityViewIsModal', true);
      expect(screen.getByLabelText('Ask for something')).toHaveProp('aria-modal', true);
      expect(screen.getByLabelText('Requested format')).toHaveProp('role', 'radiogroup');
      expect(screen.getByLabelText('Request context')).toHaveProp('role', 'radiogroup');
      const input = screen.getByLabelText('What would you like now?');
      expect(input).toHaveProp('maxLength', 500);
      expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
      await fireEvent.changeText(input, 'A private question');
      await fireEvent.press(screen.getByRole('radio', { name: 'About this encounter' }));
      await fireEvent.press(screen.getByRole('radio', { name: 'Scroll' }));
      expect(screen.getByRole('radio', { name: 'Scroll' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Either' })).not.toBeChecked();
      await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(screen.getByLabelText('What would you like now?')).toHaveProp('editable', false);
      expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Close request' }));
      await fireEvent(screen.getByTestId('encounter-overlay-modal'), 'requestClose');
      expect(close).toHaveBeenCalledTimes(2);
      expect(h.calls.filter((call) => call.path.endsWith('/cancel'))).toEqual([]);
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  const sheet = (h: ReturnType<typeof requestHarness>, close: () => void) => (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 800 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
      }}
    >
      <DisplayProvider value={{ width: 390, textScale: 1 }}>
        <EncounterOverlay label="Ask for something" presentation="sheet" onClose={close}>
          <RequestPanel session={h.session} onClose={close} />
        </EncounterOverlay>
      </DisplayProvider>
    </SafeAreaProvider>
  );

  it("says couldn't prepare with Try again and Ask differently, and can't be made with neither", async () => {
    const h = requestHarness();
    const screen = await render(sheet(h, jest.fn()));
    try {
      await fireEvent.changeText(screen.getByLabelText('What would you like now?'), 'Football tactics');
      await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));

      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'could_not_prepare' });
      await act(() => h.session.refresh());
      expect(screen.getByText("We couldn't prepare this one")).toBeTruthy();
      expect(screen.getByLabelText("Couldn't prepare")).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Ask differently' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Ask something else' })).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: 'Ask differently' }));
      expect(screen.getByLabelText('What would you like now?')).toHaveProp('value', 'Football tactics');

      await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(h.session.getState().phase).toBe('accepted'));
      h.setStatus({ ...h.fields, requestRevision: 3, status: 'unavailable', reason: 'unsupported_request' });
      await act(() => h.session.refresh());
      expect(screen.getByLabelText("Can't be made")).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Ask something else' })).toBeTruthy();
      // A Reel or variant ask, or the daily cap, closes as budget_unavailable: permanent, so nothing to press again.
      h.setStatus({ ...h.fields, requestRevision: 4, status: 'unavailable', reason: 'budget_unavailable' });
      await act(() => h.session.refresh());
      expect(screen.getByLabelText("Can't be made")).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });

  it('Try again retries this same request, shows it preparing again, and says plainly when it cannot be tried again', async () => {
    const h = requestHarness();
    const screen = await render(sheet(h, jest.fn()));
    try {
      await fireEvent.changeText(screen.getByLabelText('What would you like now?'), 'Football tactics');
      await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      h.setStatus({ ...h.fields, requestRevision: 2, status: 'unavailable', reason: 'could_not_prepare' });
      await act(() => h.session.refresh());

      await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(h.calls.filter((call) => call.path.endsWith('/retry'))).toHaveLength(1);
      expect(h.calls.filter((call) => call.path === '/v1/content/requests' && call.method === 'POST')).toHaveLength(1);
      expect(screen.queryByText("We couldn't prepare this one")).toBeNull();

      h.setStatus({ ...h.fields, requestRevision: 6, status: 'unavailable', reason: 'could_not_prepare' });
      h.setRetryOutcome('not_retryable');
      await act(() => h.session.refresh());
      await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(screen.getByText(/can't be tried again/)).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Ask differently' })).toBeTruthy();
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });
});
