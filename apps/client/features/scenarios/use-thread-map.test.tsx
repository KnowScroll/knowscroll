import { act, renderHook } from '@testing-library/react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { ScenarioCard, ThreadEpisode } from '@knowscroll/contracts';
import { useThreadMap } from './use-thread-map';

const id = (n: number) => `0199a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const episodes: ThreadEpisode[] = [1, 2].map((part) => ({
  assetId: id(0xa0 + part),
  kind: 'scroll',
  part,
  title: `Part ${String(part)}`,
  state: 'available',
  visited: false,
})) as unknown as ThreadEpisode[];
const asha = { kind: 'person' as const, personId: id(0xa), handle: 'ci.asha', displayName: 'Asha' };
const card = (n: number, patch: Partial<ScenarioCard> = {}): ScenarioCard => ({
  nodeId: id(n),
  kind: 'what_if',
  origin: 'root',
  title: `Idea ${String(n)}`,
  changes: [],
  kept: [],
  hypothetical: true,
  speculative: false,
  assumptions: [],
  startedBy: asha,
  status: 'ready',
  revision: 1,
  createdAt: '2026-10-24T10:00:00.000Z',
  content: { kind: 'scroll', assetId: id(0x100 + n), assetRevision: 1, title: 'A Scroll' },
  ...patch,
});

function scopeOf() {
  const stored = new Map<string, string>();
  const scope = {
    storage: {
      get: (key: string) => stored.get(key),
      set: (key: string, value: string) => void stored.set(key, value),
      remove: (key: string) => void stored.delete(key),
    },
  } as unknown as AccountScope;
  return { scope, stored };
}

const map = (scope: AccountScope, cards: ScenarioCard[]) =>
  renderHook(() =>
    useThreadMap({
      scope,
      threadId: id(1),
      threadTitle: 'Black holes',
      episodes,
      rootAssetId: episodes[0]?.assetId,
      cards,
      suggestions: [],
      ownPersonId: asha.personId,
      selectedAssetId: undefined,
    }),
  );

const some = (count: number) => Array.from({ length: count }, (_, index) => card(index + 1));

describe('the thread map', () => {
  it('is only an outline while it is small, whatever filter was kept', async () => {
    const { scope, stored } = scopeOf();
    stored.set(`thread.map.${id(1)}`, JSON.stringify({ filter: 'suggestions', expanded: [] }));
    const hook = await map(scope, some(2));
    expect(hook.result.current.large).toBe(false);
    expect(hook.result.current.filter).toBe('everyone');
    expect(hook.result.current.view.rows.filter((row) => row.kind === 'branch')).toHaveLength(2);
  });

  it('keeps the filter and the opened groups for this thread on this device once it is large', async () => {
    const { scope, stored } = scopeOf();
    const hook = await map(scope, some(7));
    expect(hook.result.current.large).toBe(true);
    await act(() => hook.result.current.setFilter('mine'));
    expect(hook.result.current.filter).toBe('mine');
    await act(() => hook.result.current.showMore('root'));
    expect(stored.get(`thread.map.${id(1)}`)).toContain('"mine"');
    expect(stored.get(`thread.map.${id(1)}`)).toContain('root');
    const again = await map(scope, some(7));
    expect(again.result.current.filter).toBe('mine');
  });

  it('opens and closes without touching what was read', async () => {
    const { scope } = scopeOf();
    const hook = await map(scope, some(2));
    expect(hook.result.current.open).toBe(false);
    await act(() => hook.result.current.show());
    expect(hook.result.current.open).toBe(true);
    await act(() => hook.result.current.close());
    expect(hook.result.current.open).toBe(false);
  });
});
