import type * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { SignedInSaved } from './saved-screen';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useRouter: () => ({ navigate: jest.fn() }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('../../platform/command-id', () => ({
  newCommandId: () => jest.requireActual<{ randomUUID: () => string }>('node:crypto').randomUUID(),
}));
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
/** Authored forty-five-item list and exact Keep reads over the real bounded session. */
it('pages through every loaded card with scoped server places and no more than four concurrent reads', async () => {
  let reads = 0;
  let peak = 0;
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'pages@fixture.test' },
    baseUrl: 'https://fixture.test',
    authorization: () => undefined,
    store: memoryStore(),
    fetch: async (request) => {
      if (new URL(request.url).pathname === '/v1/saved')
        return json({
          revision: 1,
          items: Array.from({ length: 45 }, (_, n) => ({
            assetId: id(100 + n),
            assetRevision: 1,
            savedAt: '2026-10-22T00:00:00.000Z',
            metadata: { kind: 'reel', title: `Saved fixture ${n + 1}`, summary: 'Authored fixture', language: 'en' },
            availability: 'available',
          })),
        });
      const body = (await request.json()) as { target: { assetId: string; assetRevision: number } };
      seen.push(body.target.assetId);
      reads++;
      peak = Math.max(peak, reads);
      await gate;
      reads--;
      return json({
        version: 'keep-place.v1',
        scope: { accountId: id(1), privacyEpoch: 1 },
        target: body.target,
        status: 'available',
        entry: { ...body.target, savedEntryId: id(Number(body.target.assetId.slice(-12)) + 1000) },
        place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 65432 } },
      });
    },
  });
  const view = await render(
    <QueryClientProvider client={scope.queryClient}>
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SignedInSaved scope={scope} />
      </DisplayProvider>
    </QueryClientProvider>,
  );
  try {
    await screen.findByText('Saved fixture 1');
    await waitFor(() => expect(seen).toHaveLength(4));
    expect(peak).toBe(4);
    expect(screen.getAllByTestId('saved-encounter-card')).toHaveLength(20);
    expect(screen.queryByText('Saved fixture 21')).toBeNull();
    release();
    await waitFor(() => expect(screen.getAllByText('Saved place: 1:05 · opens paused')).toHaveLength(20));
    await fireEvent.press(screen.getByRole('button', { name: 'Next 20 saved encounters' }));
    await screen.findByText('Saved fixture 21');
    expect(screen.queryByText('Saved fixture 1')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Next 20 saved encounters' }));
    await screen.findByText('Saved fixture 45');
    expect(screen.getAllByTestId('saved-encounter-card')).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Next 20 saved encounters' })).toBeDisabled();
    await waitFor(() => expect(seen).toContain(id(144)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(scope.storage.get('keep.place')).toBeUndefined();
  } finally {
    release();
    await view.unmount();
    scope.end();
  }
});
