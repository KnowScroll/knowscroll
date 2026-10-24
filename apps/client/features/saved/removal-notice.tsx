import { Banner } from '@knowscroll/ui';
import type { SavedRemovalState } from './saved-query';

/**
 * What the person needs to know while a Keep removal runs: the five-second grace with Undo, a
 * quiet working state, and honest failure. Quiet when nothing is happening. Shared by Keep,
 * Explore and the direct routes so the words are the same everywhere.
 */
export function RemovalNotice({
  removal,
  undo,
  retry,
}: {
  readonly removal: SavedRemovalState | undefined;
  readonly undo: () => void;
  readonly retry: () => void;
}) {
  const status = removal?.status;
  if (status === 'grace')
    return (
      <Banner
        kind="info"
        lead="Removing from Keep."
        message="It goes in five seconds."
        action={{ label: 'Undo removal', onPress: undo }}
      />
    );
  if (status === 'preparing' || status === 'sending')
    return <Banner kind="reconnecting" lead="Removing from Keep." message="One moment." />;
  if (status === 'unknown')
    return (
      <Banner
        kind="error"
        lead="Removal wasn't confirmed."
        message="It may still be in Keep."
        action={{ label: 'Retry removal', onPress: retry }}
      />
    );
  if (status === 'unavailable')
    return <Banner kind="error" lead="Couldn't remove it." message="Check Keep before trying again." />;
  return null;
}
