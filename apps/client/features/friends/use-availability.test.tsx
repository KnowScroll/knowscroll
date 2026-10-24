import type * as React from 'react';
import type { EffectCallback } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { friend, visitServer } from '@knowscroll/client-core/visit-fixture';
import { useAvailability } from './use-availability';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]) };
});
jest.mock('../../platform/command-id', () => {
  let next = 60000;
  return { newCommandId: () => `0199a000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});
beforeEach(() => {
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

function Word({ scope }: { readonly scope: ReturnType<typeof visitServer>['scope'] }) {
  const availabilityOf = useAvailability(scope);
  return <Text testID="word">{availabilityOf(friend.personId) ?? 'none'}</Text>;
}

describe('friends’ availability on a screen (labelled in-memory server)', () => {
  it('shows the word while it is fresh and nothing once its lease has run out', async () => {
    const server = visitServer();
    server.setAvailability(friend.personId, { state: 'online', expiryRevision: 1, validForMs: 300 });
    const rendered = await render(<Word scope={server.scope} />);
    await waitFor(() => expect(screen.getByTestId('word')).toHaveTextContent('online'));
    await waitFor(() => expect(screen.getByTestId('word')).toHaveTextContent('none'), { timeout: 2000 });
    await rendered.unmount();
    server.scope.end();
  });

  it('shows nothing for a friend whose availability is unknown, and nothing at all while the app is in the background', async () => {
    const server = visitServer();
    server.setAvailability(friend.personId, { state: 'online', expiryRevision: 1, validForMs: 30_000 });
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    const rendered = await render(<Word scope={server.scope} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByTestId('word')).toHaveTextContent('none');
    expect(server.countOf('/v1/social/friends/page')).toBe(0);
    await rendered.unmount();
    server.scope.end();
  });
});
