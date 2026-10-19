import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { DisplayProvider } from '@knowscroll/ui';

/**
 * The real route tree (`./app`) under a pinned display: React Native's Jest preset reports a
 * 750 px window at 200 % text, so each test says which device it means.
 */
function renderApp(initialUrl: string, width = 390) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  return renderRouter('./app', { initialUrl, wrapper });
}

describe('navigation shell', () => {
  it('opens Explore at the site root, on its first-arrival state', async () => {
    const app = await renderApp('/');

    expect(await screen.findByText('Nothing is ready to play yet.')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/explore');
    expect(screen.getByLabelText('How to move around')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Explore', selected: true })).toBeOnTheScreen();
  });

  it('dismisses the first-arrival hint with Got it', async () => {
    await renderApp('/explore');

    await fireEvent.press(await screen.findByRole('button', { name: 'Got it' }));

    expect(screen.queryByLabelText('How to move around')).toBeNull();
    expect(screen.getByText('Nothing is ready to play yet.')).toBeOnTheScreen();
  });

  it('moves between the four destinations from the tab bar', async () => {
    const app = await renderApp('/explore');

    await fireEvent.press(await screen.findByRole('tab', { name: 'Keep' }));
    expect(app.getPathname()).toBe('/saved');
    expect(screen.getByText('Nothing kept yet')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('tab', { name: 'Talk' }));
    expect(app.getPathname()).toBe('/conversations');
    expect(screen.getByText('No conversations yet')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('tab', { name: 'Universe' }));
    expect(app.getPathname()).toBe('/universe');
    expect(screen.getByText('Your universe starts quiet.')).toBeOnTheScreen();
  });

  it.each(['/explore', '/universe', '/conversations', '/saved'])(
    '%s has the account avatar in its header (D-006 c)',
    async (url) => {
      await renderApp(url);
      expect(await screen.findByRole('link', { name: 'Account and settings' })).toBeOnTheScreen();
    },
  );

  it('opens the account screen from the avatar and returns with Back', async () => {
    const app = await renderApp('/saved');

    await fireEvent.press(await screen.findByRole('link', { name: 'Account and settings' }));
    expect(app.getPathname()).toBe('/account');
    expect(screen.getByText("You're not signed in")).toBeOnTheScreen();
    expect(screen.queryByRole('tab', { selected: true })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(app.getPathname()).toBe('/saved');
  });

  it('goes to Explore from the empty universe', async () => {
    const app = await renderApp('/universe');

    await fireEvent.press(await screen.findByRole('link', { name: 'Go to Explore' }));

    expect(app.getPathname()).toBe('/explore');
  });

  it('renders no control whose backend does not exist yet on Talk', async () => {
    await renderApp('/conversations');

    expect(await screen.findByRole('link', { name: 'Share something' })).toBeOnTheScreen();
    expect(screen.queryByText('Invite a friend')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
  });

  it('uses the rail on tablets with the avatar still in the header', async () => {
    await renderApp('/saved', 834);

    expect(await screen.findByText('Nothing kept yet')).toBeOnTheScreen();
    expect(screen.getAllByRole('link', { name: 'Account and settings' })).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'Keep', selected: true })).toHaveStyle({ width: 60 });
  });

  it('moves the avatar into the desktop rail', async () => {
    const app = await renderApp('/saved', 1440);

    expect(await screen.findByText('Nothing kept yet')).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Keep', selected: true })).toHaveStyle({ width: 72 });
    const avatars = screen.getAllByRole('link', { name: 'Account and settings' });
    expect(avatars).toHaveLength(1);

    await fireEvent.press(avatars[0]!);
    expect(app.getPathname()).toBe('/account');
  });

  it('keeps the developer gallery out of builds made without EXPO_PUBLIC_KS_GALLERY', async () => {
    await renderApp('/gallery');
    expect(await screen.findByText("This page isn't here")).toBeOnTheScreen();
    expect(screen.queryByText('Components')).toBeNull();
  });

  it('reserves the sign-in routes for S1.3 without buttons that lead nowhere', async () => {
    await renderApp('/welcome');
    expect(await screen.findByText("Sign-in isn't available yet. This build has no accounts.")).toBeOnTheScreen();
    expect(screen.queryAllByRole(/^(button|link)$/)).toHaveLength(0);
  });
});
