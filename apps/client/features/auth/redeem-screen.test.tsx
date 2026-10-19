import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import {
  createAccountScopeManager,
  memoryStore,
  type AuthClient,
  type PeekOutcome,
  type SessionTokenStore,
} from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { RedeemScreen } from './redeem-screen';

/**
 * The redeem page's confirmation (review m8): a link is checked first and redeemed only after the
 * person taps "Continue as m•••@domain". Over a fixture auth client (no network, no API);
 * accounts and addresses are fixtures.
 */
const accountB = {
  accountId: '0199b000-0000-7000-8000-00000000000b',
  universeId: '0199b000-0000-7000-8000-0000000000bb',
  privacyEpoch: 1,
  email: 'b@scope.test',
};
const link = `https://app.example.test/redeem#token=ksl_${'B'.repeat(43)}`;

function fixtureAuth(peek: PeekOutcome) {
  return {
    requestLink: jest.fn(() => Promise.resolve({ kind: 'requested' as const })),
    peek: jest.fn(() => Promise.resolve(peek)),
    redeem: jest.fn(() =>
      Promise.resolve({
        kind: 'signed_in' as const,
        response: {
          account: accountB,
          accountCreated: false,
          replayed: false,
          session: { kind: 'bearer' as const, token: `kss_${'b'.repeat(43)}`, expiresAt: '2026-11-18T00:00:00.000Z' },
        },
      }),
    ),
    session: jest.fn(() => Promise.resolve({ kind: 'signed_out' as const })),
    signOut: jest.fn(() => Promise.resolve('signed_out' as const)),
  } satisfies AuthClient;
}

const noToken: SessionTokenStore = {
  read: () => Promise.resolve(undefined),
  write: () => Promise.resolve(),
  clear: () => Promise.resolve(),
};

async function renderRedeem(auth: AuthClient) {
  const manager = createAccountScopeManager({
    baseUrl: 'https://app.scope.test',
    platform: 'native',
    tokens: noToken,
    store: memoryStore(),
    auth,
    newQueryClient: () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } }),
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{children}</DisplayProvider>
  );
  // As in the app's root layout: the provider sits inside the router, so a new scope remounts the
  // screens but keeps the navigation state.
  const Layout = () => (
    <AccountScopeProvider manager={manager}>
      <Slot />
    </AccountScopeProvider>
  );
  return renderRouter(
    {
      _layout: Layout,
      redeem: () => <RedeemScreen />,
      explore: () => <Text>Explore</Text>,
      recover: () => <Text>Recover</Text>,
      signin: () => <Text>Sign in</Text>,
    },
    { initialUrl: '/redeem', wrapper },
  );
}

describe('the redeem page', () => {
  it('shows whose account the link opens and redeems only after "Continue as …" is tapped', async () => {
    const auth = fixtureAuth({ kind: 'usable', maskedEmail: 'b•••@scope.test' });
    const app = await renderRedeem(auth);
    await fireEvent.changeText(await screen.findByLabelText('Sign-in link'), link);
    const proceed = await screen.findByRole('button', { name: 'Continue as b•••@scope.test' });
    expect(
      screen.getByText("This link signs you in as b•••@scope.test. Continue only if that's your email."),
    ).toBeOnTheScreen();
    expect(auth.peek).toHaveBeenCalledWith({ token: `ksl_${'B'.repeat(43)}`, client: 'native' });
    expect(auth.redeem).not.toHaveBeenCalled();
    await fireEvent.press(proceed);
    expect(await screen.findByText('Explore')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/explore');
    expect(auth.redeem).toHaveBeenCalledTimes(1);
    expect(auth.redeem).toHaveBeenCalledWith(
      expect.objectContaining({ token: `ksl_${'B'.repeat(43)}`, client: 'native' }),
    );
  });

  it('sends a link that would not work to "This link didn’t work" without redeeming it', async () => {
    const auth = fixtureAuth({ kind: 'link_invalid' });
    const app = await renderRedeem(auth);
    await fireEvent.changeText(await screen.findByLabelText('Sign-in link'), link);
    expect(await screen.findByText('Recover')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/recover');
    expect(auth.redeem).not.toHaveBeenCalled();
  });
});
