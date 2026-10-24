import { QueryClient } from '@tanstack/react-query';
import { Slot, router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import type { ReactNode } from 'react';
import { Text } from 'react-native';
import {
  createAccountScopeManager,
  memoryStore,
  type AuthClient,
  type SessionTokenStore,
} from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { AccountScopeProvider } from '../../providers/account-scope';
import { RedeemScreen } from './redeem-screen';

/**
 * The redeem page opened by an app link (the link stays the app's current URL while the person signs in
 * and after). Over a fixture auth client; accounts and addresses are fixtures.
 */
let mockLinkToken: string | undefined;
jest.mock('../../platform/sign-in-link', () => ({
  ...jest.requireActual<object>('../../platform/sign-in-link-token'),
  useSignInLinkToken: () => mockLinkToken,
}));

const account = {
  accountId: '0199b000-0000-7000-8000-00000000000b',
  universeId: '0199b000-0000-7000-8000-0000000000bb',
  privacyEpoch: 1,
  email: 'b@scope.test',
};

function fixtureAuth() {
  return {
    requestLink: jest.fn(() => Promise.resolve({ kind: 'requested' as const })),
    peek: jest.fn(() => Promise.resolve({ kind: 'usable' as const, email: 'b•••@scope.test' })),
    redeem: jest.fn(() =>
      Promise.resolve({
        kind: 'signed_in' as const,
        response: {
          account,
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

async function renderRedeemFromLink(auth: AuthClient, token: string) {
  mockLinkToken = token;
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
  const Layout = () => (
    <AccountScopeProvider manager={manager}>
      <Slot />
    </AccountScopeProvider>
  );
  const app = await renderRouter(
    {
      _layout: Layout,
      redeem: () => <RedeemScreen />,
      explore: () => <Text>Explore</Text>,
      recover: () => <Text>Recover</Text>,
    },
    { initialUrl: '/redeem', wrapper },
  );
  return { app, manager };
}

async function signInThroughTheLink(auth: ReturnType<typeof fixtureAuth>) {
  await fireEvent.press(await screen.findByRole('button', { name: 'Continue as b•••@scope.test' }));
  expect(await screen.findByText('Explore')).toBeOnTheScreen();
  expect(auth.redeem).toHaveBeenCalledTimes(1);
}

describe('the redeem page opened by an app link', () => {
  it('goes to Explore, without asking about the spent link again, when it is shown again while that account is signed in', async () => {
    const auth = fixtureAuth();
    const { app } = await renderRedeemFromLink(auth, `ksl_${'D'.repeat(43)}`);
    await signInThroughTheLink(auth);
    expect(auth.peek).toHaveBeenCalledTimes(1);

    await act(() => {
      router.push('/redeem');
    });
    expect(await screen.findByText('Explore')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/explore');
    expect(auth.peek).toHaveBeenCalledTimes(1);
  });

  it('asks about a spent link as usual once the person has signed out, and goes to "This link didn’t work"', async () => {
    const auth = fixtureAuth();
    const { app, manager } = await renderRedeemFromLink(auth, `ksl_${'E'.repeat(43)}`);
    await signInThroughTheLink(auth);

    await act(async () => {
      await manager.signOut();
    });
    auth.peek.mockResolvedValueOnce({ kind: 'link_invalid' } as never);
    await act(() => {
      router.push('/redeem');
    });
    expect(await screen.findByText('Recover')).toBeOnTheScreen();
    expect(app.getPathname()).toBe('/recover');
    expect(auth.peek).toHaveBeenCalledTimes(2);
  });
});
