import { useSyncExternalStore } from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { harness } from './encounter-session.fixture';
import { useEncounterContext } from './use-encounter-context';

describe('active scoped exposure context query', () => {
  it('catches up invalidated action state, while a retained Back uses its cached context and sends no lineage commands', async () => {
    const h = harness();
    const calls = (suffix: string) => h.calls.filter((call) => call.path.endsWith(suffix));
    h.session.setForeground(true);
    h.session.open({ kind: 'discover' });
    await waitFor(() => expect(h.session.getState().phase).toBe('active'));
    function Host() {
      const state = useSyncExternalStore(h.session.subscribe, h.session.getState, h.session.getState);
      useEncounterContext(h.scope, h.session, state.entry, true);
      return null;
    }
    const app = await render(
      <QueryClientProvider client={h.scope.queryClient}>
        <Host />
      </QueryClientProvider>,
    );
    try {
      h.setSaved(true);
      await act(() => h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() }));
      await waitFor(() => expect(h.session.getState().entry?.context.actions.saved).toBe(true));
      expect(calls('/context')).toHaveLength(2);
      await act(() => h.session.navigate({ mode: 'vertical', direction: 'next' }));
      await waitFor(() => expect(h.session.getState().trail).toHaveLength(2));
      const before = h.calls.length;
      await act(() => {
        h.session.back();
      });
      expect(h.session.getState().trail).toHaveLength(1);
      expect(h.calls).toHaveLength(before);
      expect(h.session.getState().entry?.context.actions.saved).toBe(true);
      expect(calls('/open')).toHaveLength(1);
      expect(calls('/activate')).toHaveLength(2);
      h.scope.end();
      h.setSaved(false);
      await act(() => h.scope.queryClient.invalidateQueries({ queryKey: h.scope.queryKey() }));
      expect(h.session.getState().trail).toEqual([]);
      expect(h.store.keys()).toEqual([]);
    } finally {
      await app.unmount();
      h.scope.end();
    }
  });
});
