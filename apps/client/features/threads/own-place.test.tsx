import { act, renderHook } from '@testing-library/react-native';
import { createAccountScope, memoryStore, type AccountScope } from '@knowscroll/client-core';
import { useOwnPlace } from './own-place';

const threadId = '0199a000-0000-7000-8000-000000000060';

function scopeWith(store = memoryStore()): AccountScope {
  return createAccountScope({
    account: {
      accountId: '0199a000-0000-7000-8000-000000000001',
      universeId: '0199a000-0000-7000-8000-000000000002',
      privacyEpoch: 1,
      email: 'place@threads.test',
    },
    baseUrl: 'https://place.threads.test',
    authorization: () => undefined,
    store,
    fetch: () => Promise.resolve(new Response('{}', { status: 404 })),
  });
}

describe('the person’s own place in a thread', () => {
  it('starts folded where the screen asks for it, and open where it does not', async () => {
    const phone = await renderHook(() => useOwnPlace(scopeWith(), threadId, true));
    expect(phone.result.current.folded).toBe(true);
    const desktop = await renderHook(() => useOwnPlace(scopeWith(), threadId, false));
    expect(desktop.result.current.folded).toBe(false);
  });

  it('lets the person’s own choice win over the default, and remembers it on this device', async () => {
    const scope = scopeWith();
    const first = await renderHook(() => useOwnPlace(scope, threadId, true));
    await act(() => first.result.current.setFolded(false));
    expect(first.result.current.folded).toBe(false);
    // The same scope, later, on a screen whose default is the opposite: the choice stays.
    const later = await renderHook(() => useOwnPlace(scope, threadId, true));
    expect(later.result.current.folded).toBe(false);
  });

  it('keeps the selected episode on this device only', async () => {
    const scope = scopeWith();
    const first = await renderHook(() => useOwnPlace(scope, threadId));
    await act(() => first.result.current.select('episode-2'));
    const later = await renderHook(() => useOwnPlace(scope, threadId));
    expect(later.result.current.selected).toBe('episode-2');
  });
});
