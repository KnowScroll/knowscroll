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
});
