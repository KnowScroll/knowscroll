import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { DisplayProvider } from '@knowscroll/ui';

/**
 * The sign-in routes (S1.3 #226) in the real route tree, signed out (no session in this test
 * environment, so the AccountScope starts signed out). Network answers are covered by the
 * AccountScope tests, the web smoke and the release tests.
 */
function renderApp(initialUrl: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  return renderRouter('./app', { initialUrl, wrapper });
}

describe('sign-in screens', () => {
  it('welcome offers email and an existing link, and opens the email form', async () => {
    const app = await renderApp('/welcome');
    expect(await screen.findByRole('header', { name: 'KnowScroll' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'I have a sign-in link' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('link', { name: 'Continue with email' }));
    expect(app.getPathname()).toBe('/signin');
    expect(await screen.findByLabelText('Email address')).toBeOnTheScreen();
  });

  it('refuses a malformed address before asking the server', async () => {
    await renderApp('/signin');
    await fireEvent.changeText(await screen.findByLabelText('Email address'), 'not-an-address');
    await fireEvent.press(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Enter an email address like name@example.com.')).toBeOnTheScreen();
  });

  it('asks for the link when none opened the page, and checks a pasted one before offering to continue', async () => {
    await renderApp('/redeem');
    expect(await screen.findByText('Use your sign-in link')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fireEvent.changeText(
      screen.getByLabelText('Sign-in link'),
      `https://app.example.test/redeem#token=ksl_${'A'.repeat(43)}`,
    );
    // No API in this test environment: the check fails as offline, and nothing was redeemed.
    expect(await screen.findByText("Can't reach KnowScroll.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('explains a failed link and offers a new one', async () => {
    await renderApp('/recover?reason=link');
    expect(await screen.findByText("This link didn't work")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Use a different email' })).toBeOnTheScreen();
  });

  it('says plainly when the session ended', async () => {
    await renderApp('/recover');
    expect(await screen.findByText('You were signed out')).toBeOnTheScreen();
    expect(screen.getByRole('link', { name: 'Sign in again' })).toBeOnTheScreen();
  });
});
