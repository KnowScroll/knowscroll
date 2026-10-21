import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope, KeepPlaceState } from '@knowscroll/client-core';
import type { ListSavedResponse } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Text } from '@knowscroll/ui';
import { createKeepView, type AvailableKeep } from './keep-place-bridge';

export function KeepWriteStatus({
  state,
  refresh,
  retry,
  resolve,
}: {
  readonly state?: KeepPlaceState;
  readonly refresh: () => void;
  readonly retry: () => void;
  readonly resolve: (choice: 'server' | 'candidate') => void;
}) {
  if (!state) return null;
  if (state.status === 'ended') return null;
  return (
    <View style={styles.stack}>
      {state.write === 'sending' ? <Text variant="meta">Updating your saved place…</Text> : null}
      {state.write === 'refreshing' ? <Text variant="meta">Checking the latest saved place…</Text> : null}
      {state.write === 'unknown' ? (
        <>
          <Text variant="bodyS">That update wasn't confirmed. Retry checks the same update.</Text>
          <Button label="Retry place update" onPress={retry} />
        </>
      ) : null}
      {state.write === 'conflict' ? (
        <>
          <Text variant="bodyS">Your saved place changed. Choose which place to keep.</Text>
          <Button label="Use current saved place" onPress={() => resolve('server')} />
          <Button label="Replace with my chosen place" variant="ghost" onPress={() => resolve('candidate')} />
        </>
      ) : null}
      {state.status === 'unavailable' ? (
        <>
          <Text variant="bodyS">Your saved place isn't available. Nothing has been confirmed as updated.</Text>
          <Button label="Check saved place" variant="ghost" onPress={refresh} />
        </>
      ) : null}
      {state.status === 'ready' && state.write === 'idle' && state.snapshot?.status === 'available' ? (
        <Text variant="meta">Latest saved place loaded.</Text>
      ) : null}
    </View>
  );
}
export function KeepDetail({
  scope,
  item,
  onBack,
  onOpen,
}: {
  readonly scope: AccountScope;
  readonly item: ListSavedResponse['items'][number];
  readonly onBack: () => void;
  readonly onOpen: (mode: 'resume' | 'top', snapshot?: AvailableKeep) => void;
}) {
  const view = useMemo(
    () => createKeepView(scope, { assetId: item.assetId, assetRevision: item.assetRevision }),
    [scope, item.assetId, item.assetRevision],
  );
  useFocusEffect(
    useCallback(() => {
      view.start();
      return () => view.stop();
    }, [view]),
  );
  const state = useSyncExternalStore(view.subscribe, view.getState, view.getState);
  const snapshot = state.status === 'ready' && state.snapshot?.status === 'available' ? state.snapshot : undefined;
  const position = snapshot?.place.status === 'set' ? snapshot.place.position : undefined;
  return (
    <View style={styles.stack} testID="keep-detail">
      <Button label="Back to Keep" variant="ghost" onPress={onBack} />
      <Text variant="title" heading={2}>
        {item.metadata?.title ?? 'Saved encounter'}
      </Text>
      {item.metadata?.summary ? <Text variant="bodyS">{item.metadata.summary}</Text> : null}
      <Text variant="meta">Where you left off</Text>
      {state.status === 'loading' ? <Skeleton rows={2} label="Loading saved place" /> : null}
      {state.status === 'ready' && state.snapshot?.status === 'not_saved' ? (
        <Text variant="bodyS">This version is no longer in Keep.</Text>
      ) : null}
      {state.status === 'ready' && state.snapshot?.status === 'saved_unavailable' ? (
        <Text variant="bodyS">
          This saved version's place isn't available. An updated version doesn't inherit its place.
        </Text>
      ) : null}
      {snapshot?.place.status === 'none' ? (
        <Text variant="bodyS">No place kept yet. Use Keep this place while viewing to update it.</Text>
      ) : null}
      {position?.kind === 'reel' ? (
        <Text variant="bodyS">
          Paused at {Math.floor(position.positionMs / 60000)}:
          {String(Math.floor(position.positionMs / 1000) % 60).padStart(2, '0')}
        </Text>
      ) : null}
      {position?.kind === 'scroll' ? <Text variant="bodyS">Your reading place is kept.</Text> : null}
      {position ? (
        <Button
          label="Resume saved place"
          disabled={state.write !== 'idle'}
          onPress={() => onOpen('resume', snapshot)}
        />
      ) : null}
      {item.availability !== 'withdrawn' ? (
        <Button label="Start from the top" variant="ghost" onPress={() => onOpen('top')} />
      ) : (
        <Banner kind="info" lead="This encounter was withdrawn." message="It can't be opened." />
      )}
      {item.availability === 'corrected' ? (
        <Text variant="bodyS">
          This is your original saved version. Choose the updated version separately from the library.
        </Text>
      ) : null}
      <KeepWriteStatus state={state} refresh={view.refresh} retry={view.retry} resolve={view.resolveConflict} />
      <Text variant="meta">
        Opening this detail records no reading or watching. Saved places are checked again before resuming.
      </Text>
    </View>
  );
}
const styles = StyleSheet.create({ stack: { gap: spacing[3] } });
