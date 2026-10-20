import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { RequestPanel } from './request-panel';
import { requestHarness } from './request-session.fixture';

describe('E04 request panel', () => {
  it('provides labelled input and explicit choices under the 320px/200% display configuration', async () => {
    const h = requestHarness();
    const close = jest.fn();
    const screen = await render(
      <DisplayProvider value={{ width: 320, textScale: 2 }}>
        <RequestPanel session={h.session} onClose={close} />
      </DisplayProvider>,
    );
    try {
      const input = screen.getByLabelText('What would you like now?');
      expect(input).toHaveProp('maxLength', 500);
      expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled();
      await fireEvent.changeText(input, 'A private question');
      await fireEvent.press(screen.getByRole('button', { name: 'About this encounter' }));
      await fireEvent.press(screen.getByRole('button', { name: 'Scroll' }));
      await fireEvent.press(screen.getByRole('button', { name: 'Send request' }));
      await waitFor(() => expect(h.session.getState().status?.status).toBe('preparing'));
      expect(screen.getByLabelText('What would you like now?')).toHaveProp('editable', false);
      expect(screen.getByRole('button', { name: 'Cancel request' })).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'Close request' }));
      expect(close).toHaveBeenCalledTimes(1);
      expect(h.calls.filter((call) => call.path.endsWith('/cancel'))).toEqual([]);
    } finally {
      await screen.unmount();
      await act(() => h.scope.end());
    }
  });
});
