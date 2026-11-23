import { renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { DisplayProvider } from '@knowscroll/ui';
import type * as providers from '../../providers/made-to-order';
import type { MadeToOrderState } from '../../providers/made-to-order';

/**
 * `/threads/<id>/b/<node>` in the real route tree. A branch is made to order, so while the API says those are off (D-436) its
 * address is an address that is not a screen: the app's own not-found page, with its way back to Explore. While the answer is
 * not there yet nothing is drawn, so a branch never shows and then goes. The root layout mounts the real provider (signed out here:
 * off), so each case sets what the route reads instead. With nobody signed in these tests have no API behind them.
 */
const address = '/threads/0199a000-0000-7000-8000-0000000000a1/b/0199a000-0000-7000-8000-0000000000b1';

let mockState: MadeToOrderState = 'off';
jest.mock('../../providers/made-to-order', () => ({
  ...jest.requireActual<typeof providers>('../../providers/made-to-order'),
  useMadeToOrderState: () => mockState,
}));

function renderApp(state: MadeToOrderState) {
  mockState = state;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  return renderRouter('./app', { initialUrl: address, wrapper });
}

describe('the branch route and the made-to-order switch', () => {
  it('shows the app’s not-found page, never a branch screen, while the switch is off', async () => {
    await renderApp('off');
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Go to Explore' })).toBeOnTheScreen();
  });

  it('draws nothing while the answer has not arrived', async () => {
    await renderApp('unknown');
    expect(screen.queryByText("This page isn't here")).toBeNull();
    expect(screen.queryByText('This branch isn’t available here')).toBeNull();
  });

  it('opens the branch screen while the switch is on (signed out, it says it is not available here)', async () => {
    await renderApp('on');
    expect(await screen.findByText('This branch isn’t available here')).toBeOnTheScreen();
    expect(screen.queryByText("This page isn't here")).toBeNull();
  });
});
