import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { AccountScope, KeepPlaceState } from '@knowscroll/client-core';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Skeleton, Tag, Text, formatClock } from '@knowscroll/ui';
import { createKeepView, type AvailableKeep } from './keep-place-bridge';
import type { SavedItem } from './saved-query';

/**
 * Keep write outcomes that need a person, in plain words: an unconfirmed update can be retried,
 * a changed place needs a choice, an unavailable place can be checked again. Quiet otherwise.
 */
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
  if (!state || state.status === 'ended') return null;
  return (
    <View style={styles.stack}>
      {state.write === 'unknown' ? (
        <Banner
          kind="error"
          lead="Your place wasn't saved."
          message="It may still be the old one."
          action={{ label: 'Retry place update', onPress: retry }}
        />
      ) : null}
      {state.write === 'conflict' ? (
        <>
          <Banner kind="info" lead="Your saved place changed." message="Choose which place to keep." />
          <Button label="Use current saved place" onPress={() => resolve('server')} />
          <Button label="Replace with my chosen place" variant="ghost" onPress={() => resolve('candidate')} />
        </>
      ) : null}
      {state.status === 'unavailable' ? (
        <Banner
          kind="info"
          lead="Your saved place isn't available."
          message="Nothing was changed."
          action={{ label: 'Check saved place', onPress: refresh }}
        />
      ) : null}
    </View>
  );
}

/** S02: one kept encounter, where you left off, and the way back in. Opening this page records nothing. */
export function KeepDetail({
  scope,
  item,
  onBack,
  onOpen,
}: {
  readonly scope: AccountScope;
  readonly item: SavedItem;
  readonly onBack: () => void;
  readonly onOpen: (mode: 'resume' | 'top', snapshot?: AvailableKeep) => void;
}) {
  const view = useMemo(
    () => createKeepView(scope, { assetId: item.assetId, assetRevision: item.assetRevision }, item.savedEntryId),
    [scope, item.assetId, item.assetRevision, item.savedEntryId],
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
  const format = item.kind === 'reel' ? 'Reel' : 'Scroll';
  return (
    <View style={styles.stack} testID="keep-detail">
      <View style={styles.top}>
        <IconButton icon="back" label="Back to Keep" onPress={onBack} />
      </View>
      <View style={styles.card}>
        <Tag label={format} />
        <Text variant="displayL" heading={2}>
          {item.metadata?.title ?? 'Saved encounter'}
        </Text>
        {item.metadata?.summary ? (
          <Text variant="body" color={content.ink2}>
            {item.metadata.summary}
          </Text>
        ) : null}
        <View style={styles.place}>
          <Text variant="label" color={content.ink2}>
            Where you left off
          </Text>
          {state.status === 'loading' ? <Skeleton rows={1} label="Loading saved place" /> : null}
          {state.status === 'ready' && state.snapshot?.status === 'not_saved' ? (
            <Text variant="ui">This version is no longer in Keep.</Text>
          ) : null}
          {state.status === 'ready' && state.snapshot?.status === 'saved_unavailable' ? (
            <Text variant="ui">
              This saved version's place isn't available. An updated version doesn't inherit its place.
            </Text>
          ) : null}
          {snapshot?.place.status === 'none' ? (
            <Text variant="ui">No place yet. It is kept when you save or leave.</Text>
          ) : null}
          {position?.kind === 'reel' ? (
            <Text variant="ui">
              {position.positionMs >= 1000
                ? `Paused at ${formatClock(position.positionMs)}`
                : 'You have not started yet.'}
            </Text>
          ) : null}
          {position?.kind === 'scroll' ? <Text variant="ui">Your reading place is kept.</Text> : null}
        </View>
      </View>
      {item.availability === 'corrected' ? (
        <Banner
          kind="corrected"
          lead="Revised since you kept it."
          message="This is the version you saved. Choose the updated one from your Keep."
        />
      ) : null}
      {position ? (
        <Button
          label="Resume where you left off"
          variant="primary"
          disabled={state.write !== 'idle'}
          onPress={() => onOpen('resume', snapshot)}
        />
      ) : null}
      {item.availability !== 'withdrawn' ? (
        <Button
          label="Start from the top"
          disabled={!snapshot || state.write !== 'idle'}
          onPress={() => onOpen('top', snapshot)}
        />
      ) : (
        <Banner kind="info" lead="This encounter was withdrawn." message="It can't be opened." />
      )}
      <KeepWriteStatus state={state} refresh={view.refresh} retry={view.retry} resolve={view.resolveConflict} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[3] },
  top: { flexDirection: 'row' },
  card: {
    gap: spacing[3],
    padding: spacing[5],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.hero,
  },
  place: { gap: spacing[1], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.highlight },
});
