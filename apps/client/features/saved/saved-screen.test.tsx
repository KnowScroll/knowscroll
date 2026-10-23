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
/** Authored one-hundred-sixty-item paged list and exact Keep reads over the real bounded session. */
it('pages past the old hundred-item ceiling with scoped server places and no more than four concurrent reads', async () => {
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
      const url = new URL(request.url);
      if (url.pathname === '/v1/saved') {
        expect(url.searchParams.get('pagination')).toBe('saved-page.v1');
        expect(url.searchParams.get('limit')).toBe('20');
        const cursor = url.searchParams.get('cursor');
        const start = cursor ? Number(cursor.slice(-4)) : 0;
        return json({
          pagination: 'saved-page.v1',
          consistency: 'live',
          filter: url.searchParams.get('filter'),
          limit: 20,
          scope: { accountId: id(1), privacyEpoch: 1 },
          ...(cursor ? { requestCursor: cursor } : {}),
          continuation:
            start + 20 < 160
              ? { status: 'more', cursor: `ksp1_${'a'.repeat(43)}${String(start + 20).padStart(4, '0')}` }
              : { status: 'end' },
          revision: 1,
          items: Array.from({ length: 20 }, (_, offset) => {
            const n = start + offset;
            return {
              assetId: id(100 + n),
              assetRevision: 1,
              savedEntryId: id(1100 + n),
              kind: 'reel',
              savedAt: '2026-10-22T00:00:00.000Z',
              metadata: { kind: 'reel', title: `Saved fixture ${n + 1}`, summary: 'Authored fixture', language: 'en' },
              availability: 'available',
            };
          }),
        });
      }
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
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Paused at 1:05/ })).toHaveLength(20));
    for (let start = 20; start < 160; start += 20) {
      await fireEvent.press(screen.getByRole('button', { name: 'Next 20 saved encounters' }));
      await screen.findByText(`Saved fixture ${start + 1}`);
      expect(screen.getAllByTestId('saved-encounter-card')).toHaveLength(20);
      expect(scope.queryClient.getQueryCache().findAll({ queryKey: scope.queryKey('saved') })).toHaveLength(1);
    }
    expect(screen.queryByText('Saved fixture 1')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next 20 saved encounters' })).toBeNull();
    await waitFor(() => expect(seen).toContain(id(259)));
    await fireEvent.press(screen.getByRole('button', { name: 'Previous 20 saved encounters' }));
    await screen.findByText('Saved fixture 121');
    expect(peak).toBeLessThanOrEqual(4);
    expect(scope.storage.get('keep.place')).toBeUndefined();
  } finally {
    release();
    await view.unmount();
    scope.end();
  }
});
