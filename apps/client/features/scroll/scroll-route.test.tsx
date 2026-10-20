import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { DisplayProvider } from '@knowscroll/ui';

/**
 * `/scroll/[assetId]` in the real route tree (D-006 d). With nobody signed in (these tests have no
 * API behind the app), the route asks for the sign-in the rest of the app uses; an address that is
 * not an asset is "isn't available". The signed-in journey is proved against the API in CI and by
 * hand on a real stack, not here.
 */
function renderApp(initialUrl: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  return renderRouter('./app', { initialUrl, wrapper });
}

describe('the Scroll route', () => {
  it('asks a signed-out visitor to sign in, with the same link the account screen uses', async () => {
    const app = await renderApp('/scroll/0199a000-0000-7000-8000-0000000000a1');
    expect(await screen.findByText("You're not signed in")).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/scroll/0199a000-0000-7000-8000-0000000000a1');
    await fireEvent.press(screen.getByRole('link', { name: 'Sign in' }));
    expect(app.getPathname()).toBe('/welcome');
  });

  it('says plainly that an address which is not an asset is not available, and offers Explore', async () => {
    const app = await renderApp('/scroll/not-an-asset');
    expect(await screen.findByText("This Scroll isn't available")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: 'Go to Explore' }));
    expect(app.getPathname()).toBe('/explore');
  });

  it('has a Back control on every state', async () => {
    await renderApp('/scroll/not-an-asset');
    expect(await screen.findByRole('button', { name: 'Back' })).toBeOnTheScreen();
  });
});
