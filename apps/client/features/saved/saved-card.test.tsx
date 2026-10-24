import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { KeepPlaceState } from '@knowscroll/client-core';
import type { SavedPageResponse } from '@knowscroll/contracts';
import { SavedCard } from './saved-card';
const item: Extract<SavedPageResponse['items'][number], { availability: 'corrected' }> = {
  assetId: '0199a000-0000-7000-8000-000000000001',
  kind: 'reel',
  savedEntryId: '0199a000-0000-7000-8000-000000000001',
  assetRevision: 2,
  savedAt: '2026-10-20T10:00:00.000Z',
  metadata: { kind: 'reel', title: 'Corrected CI fixture', summary: 'Fixture only', language: 'en' },
  availability: 'corrected',
  currentAssetRevision: 3,
};
function card(
  value: SavedPageResponse['items'][number],
  onOpen: (revision: number) => void,
  onRemove = jest.fn(),
  place?: KeepPlaceState,
) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <SavedCard
        item={value}
        place={place}
        failed={false}
        removing={false}
        onOpen={onOpen}
        onRemove={onRemove}
        resume={{ kind: 'reel', positionMs: 12345, playing: false, muted: false }}
      />
    </DisplayProvider>,
  );
}
const available = { ...item, availability: 'available' as const, currentAssetRevision: undefined };
describe('Saved immutable revision choices', () => {
  it('makes corrected original and updated versions deliberate separate choices and keeps the private playhead', async () => {
    const open = jest.fn();
    await card(item, open);
    // The card is one button named by title, format and place; a corrected item says so first.
    await fireEvent.press(
      screen.getByRole('button', { name: 'Corrected CI fixture. Reel. Revised since you kept it' }),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Open updated version' }));
    expect(open.mock.calls).toEqual([[2], [3]]);
    expect(item.assetRevision).toBe(2);
  });
  it('a withdrawn encounter can be removed but never opened', async () => {
    const open = jest.fn();
    const remove = jest.fn();
    await card(
      { ...item, availability: 'withdrawn', metadata: undefined, currentAssetRevision: undefined },
      open,
      remove,
    );
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove from Keep' }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps Remove in the more menu on an available card, and asks nothing more before the grace starts', async () => {
    const remove = jest.fn();
    await card(available, jest.fn(), remove);
    expect(screen.queryByRole('button', { name: 'Remove from Keep' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'More for Corrected CI fixture' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove from Keep' }));
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('says Removing… on a normal card while its removal is in flight, and the menu cannot be opened again', async () => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SavedCard item={available} failed={false} removing onOpen={jest.fn()} onRemove={jest.fn()} />
      </DisplayProvider>,
    );
    expect(screen.getByText('Removing…')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'More for Corrected CI fixture' })).toBeDisabled();
  });
  it('shows Retry removal on the card itself after a failed removal', async () => {
    const remove = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <SavedCard item={available} failed removing={false} onOpen={jest.fn()} onRemove={remove} />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Retry removal' }));
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('does not display a replacement membership B playhead for paged card A', async () => {
    await card(available, jest.fn(), jest.fn(), {
      status: 'ready',
      write: 'idle',
      snapshot: {
        version: 'keep-place.v1',
        scope: { accountId: item.assetId, privacyEpoch: 1 },
        target: item,
        status: 'available',
        entry: {
          assetId: item.assetId,
          assetRevision: item.assetRevision,
          savedEntryId: '0199a000-0000-7000-8000-000000000002',
        },
        place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 65432 } },
      },
    });
    expect(screen.queryByRole('button', { name: /Paused at 1:05/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Corrected CI fixture. Reel. Not started' })).toBeOnTheScreen();
  });
  it('uses a current server place instead of a legacy local value, and labels read failure honestly', async () => {
    const place: KeepPlaceState = {
      status: 'ready',
      write: 'idle',
      snapshot: {
        version: 'keep-place.v1',
        scope: { accountId: item.assetId, privacyEpoch: 1 },
        target: { assetId: item.assetId, assetRevision: item.assetRevision },
        status: 'available',
        entry: { assetId: item.assetId, assetRevision: item.assetRevision, savedEntryId: item.assetId },
        place: { status: 'set', placeRevision: 1, position: { kind: 'reel', positionMs: 65432 } },
      },
    };
    const view = await card(available, jest.fn(), jest.fn(), place);
    expect(screen.getByRole('button', { name: 'Corrected CI fixture. Reel. Paused at 1:05' })).toBeOnTheScreen();
    await view.unmount();
    await card(available, jest.fn(), jest.fn(), { ...place, status: 'unavailable', reason: 'network' });
    expect(
      screen.getByRole('button', { name: "Corrected CI fixture. Reel. Couldn't check your place" }),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Paused at 1:05/ })).toBeNull();
  });
  it('says it is checking while the place is still loading, instead of "Not started"', async () => {
    await card(available, jest.fn(), jest.fn(), { status: 'loading', write: 'idle' });
    expect(screen.getByRole('button', { name: 'Corrected CI fixture. Reel. Checking your place…' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Not started/ })).toBeNull();
  });
});
