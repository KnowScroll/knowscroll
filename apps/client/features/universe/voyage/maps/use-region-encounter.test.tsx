import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { AvailableRegionPreview } from '@knowscroll/client-core';
import { useRegionEncounter } from './use-region-encounter';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));

const onOpen = (): boolean => true;
const none = undefined as AvailableRegionPreview | undefined;

describe('where focus goes when the region’s map goes without an encounter opened', () => {
  const original = Platform.OS;
  let target: { focus: jest.Mock };
  beforeEach(() => {
    target = { focus: jest.fn() };
    (Platform as { OS: string }).OS = 'web';
    (globalThis as { document?: unknown }).document = { querySelector: () => target };
  });
  afterEach(() => {
    (Platform as { OS: string }).OS = original;
    delete (globalThis as { document?: unknown }).document;
  });

  it('restores it to the chip that opened the map', async () => {
    const view = await renderHook(() => useRegionEncounter(none, onOpen, { restoreFocusTo: 'universe-map-open' }));
    await view.unmount();
    await Promise.resolve();
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('does not once the Universe has ended: there is nothing left to focus', async () => {
    const view = await renderHook(() =>
      useRegionEncounter(none, onOpen, { restoreFocusTo: 'universe-map-open', isLive: () => false }),
    );
    await view.unmount();
    await Promise.resolve();
    expect(target.focus).not.toHaveBeenCalled();
  });

  it('does nothing without a place to restore to', async () => {
    const view = await renderHook(() => useRegionEncounter(none, onOpen));
    await view.unmount();
    await Promise.resolve();
    expect(target.focus).not.toHaveBeenCalled();
  });
});
