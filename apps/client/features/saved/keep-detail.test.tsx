import type { useEffect } from 'react';
import type { AvailableKeep } from './keep-place-bridge';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { createAccountScope, memoryStore } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { KeepDetail, KeepWriteStatus } from './keep-detail';
import type { ListSavedResponse } from '@knowscroll/contracts';
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => (() => void) | undefined) => {
    const React = jest.requireActual<{ useEffect: typeof useEffect }>('react');
    React.useEffect(effect, [effect]);
  },
}));
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const id = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const item: ListSavedResponse['items'][number] = {
  assetId: id(3),
  assetRevision: 1,
  savedAt: '2026-10-22T00:00:00.000Z',
  availability: 'available',
  metadata: { kind: 'reel', title: 'CI saved fixture', summary: 'Authored fixture only', language: 'en' },
};
function scopeFor(status: 'available' | 'saved_unavailable' | 'not_saved' = 'available') {
  const calls: string[] = [];
  const scope = createAccountScope({
    account: { accountId: id(1), universeId: id(2), privacyEpoch: 1, email: 'detail@fixture.test' },
    baseUrl: 'https://fixture.test',
    store: memoryStore(),
    authorization: () => undefined,
    fetch: (request) => {
      calls.push(new URL(request.url).pathname);
      return Promise.resolve(
        json({
          version: 'keep-place.v1',
          scope: { accountId: id(1), privacyEpoch: 1 },
          target: { assetId: item.assetId, assetRevision: 1 },
          status,
          ...(status !== 'not_saved'
            ? { entry: { assetId: item.assetId, assetRevision: 1, savedEntryId: id(4) } }
            : {}),
          ...(status === 'available'
            ? { place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 31250.5 } } }
            : {}),
        }),
      );
    },
  });
  return { scope, calls };
}
describe('S02 selected real Keep detail', () => {
  it('reads only the selected place and offers explicit paused resume/top without a command or observation', async () => {
    const f = scopeFor();
    const open = jest.fn((_mode: 'resume' | 'top', _snapshot?: AvailableKeep) => undefined);
    const screen = await render(
      <DisplayProvider value={{ width: 320, textScale: 2 }}>
        <KeepDetail scope={f.scope} item={item} onBack={jest.fn()} onOpen={open} />
      </DisplayProvider>,
    );
    try {
      await waitFor(() => expect(screen.getByText('Paused at 0:31')).toBeOnTheScreen());
      expect(f.calls.every((p) => p.endsWith('/keep/read'))).toBe(true);
      await fireEvent.press(screen.getByRole('button', { name: 'Resume saved place' }));
      expect(open.mock.calls[0]?.[0]).toBe('resume');
      expect(open.mock.calls[0]?.[1]?.entry.savedEntryId).toBe(id(4));
      await fireEvent.press(screen.getByRole('button', { name: 'Start from the top' }));
      expect(open.mock.calls[1]).toEqual(['top']);
      await act(() => f.scope.end());
      expect(screen.queryByText('Paused at 0:31')).toBeNull();
    } finally {
      await screen.unmount();
      f.scope.end();
    }
  });
  it('does not invent a corrected old-revision place or inherit one into a new revision', async () => {
    const f = scopeFor('saved_unavailable');
    const open = jest.fn((_mode: 'resume' | 'top', _snapshot?: AvailableKeep) => undefined);
    const screen = await render(
      <DisplayProvider value={{ width: 390, textScale: 1 }}>
        <KeepDetail
          scope={f.scope}
          item={{ ...item, availability: 'corrected', currentAssetRevision: 2 }}
          onBack={jest.fn()}
          onOpen={open}
        />
      </DisplayProvider>,
    );
    try {
      await waitFor(() => expect(screen.getByText(/saved version's place isn't available/)).toBeOnTheScreen());
      expect(screen.queryByRole('button', { name: 'Resume saved place' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Remove from Keep' })).toBeNull();
      expect(open).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      f.scope.end();
    }
  });
  it('separates unknown exact replay, read refresh and deliberate CAS conflict choices', async () => {
    const retry = jest.fn();
    const refresh = jest.fn();
    const resolve = jest.fn();
    const screen = await render(
      <DisplayProvider value={{ width: 390, textScale: 1 }}>
        <KeepWriteStatus
          state={{ status: 'ready', write: 'unknown' }}
          refresh={refresh}
          retry={retry}
          resolve={resolve}
        />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Retry place update' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    await screen.rerender(
      <DisplayProvider value={{ width: 390, textScale: 1 }}>
        <KeepWriteStatus
          state={{ status: 'ready', write: 'conflict', currentPlaceRevision: 4 }}
          refresh={refresh}
          retry={retry}
          resolve={resolve}
        />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Use current saved place' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Replace with my chosen place' }));
    expect(resolve.mock.calls).toEqual([['server'], ['candidate']]);
    expect(retry).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
