import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { ListSavedResponse } from '@knowscroll/contracts';
import { SavedCard } from './saved-card';
const item: ListSavedResponse['items'][number] = {
  assetId: '0199a000-0000-7000-8000-000000000001',
  assetRevision: 2,
  savedAt: '2026-10-20T10:00:00.000Z',
  metadata: { kind: 'reel', title: 'Corrected CI fixture', summary: 'Fixture only', language: 'en' },
  availability: 'corrected',
  currentAssetRevision: 3,
};
function card(value: typeof item, onOpen: (revision: number) => void, onRemove = jest.fn()) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <SavedCard
        item={value}
        failed={false}
        removing={false}
        onOpen={onOpen}
        onRemove={onRemove}
        resume={{ kind: 'reel', positionMs: 12345, playing: false, muted: false }}
      />
    </DisplayProvider>,
  );
}
describe('Saved immutable revision choices', () => {
  it('makes corrected original and updated versions deliberate separate choices and keeps the private playhead', async () => {
    const open = jest.fn();
    await card(item, open);
    expect(screen.getByText('Your place: 0:12 · opens paused')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Open original saved version' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Open updated version' }));
    expect(open.mock.calls).toEqual([[2], [3]]);
    expect(item.assetRevision).toBe(2);
  });
  it('a withdrawn encounter can be removed but never opened', async () => {
    const open = jest.fn();
    const remove = jest.fn();
    await card({ ...item, availability: 'withdrawn', currentAssetRevision: undefined }, open, remove);
    expect(screen.queryByRole('button', { name: /Open/ })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Remove from Keep' }));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
