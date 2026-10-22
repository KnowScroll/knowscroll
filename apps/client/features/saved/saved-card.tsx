import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import type { AccountScope, KeepPlaceState } from '@knowscroll/client-core';
import { createKeepView } from './keep-place-bridge';
import { StyleSheet, View } from 'react-native';
import type { SavedItem } from './saved-query';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import type { PrivatePosition } from '../encounter/encounter-history';

type Item = SavedItem;
export function SavedCard({
  item,
  resume,
  place,
  failed,
  removing,
  onRemove,
  onOpen,
}: {
  readonly item: Item;
  readonly resume?: PrivatePosition;
  readonly place?: KeepPlaceState;
  readonly failed: boolean;
  readonly removing: boolean;
  readonly onRemove: () => void;
  readonly onOpen: (revision: number) => void;
}) {
  const withdrawn = item.availability === 'withdrawn';
  const savedPosition =
    place?.status === 'ready' &&
    place.snapshot?.status === 'available' &&
    place.snapshot.entry.savedEntryId === item.savedEntryId &&
    place.snapshot.entry.assetId === item.assetId &&
    place.snapshot.entry.assetRevision === item.assetRevision &&
    place.snapshot.place.status === 'set'
      ? place.snapshot.place.position
      : undefined;
  return (
    <View style={styles.card} testID="saved-encounter-card">
      <Text variant="meta">{item.kind === 'reel' ? 'Reel' : 'Scroll'}</Text>
      <Text variant="title" heading={2}>
        {item.metadata?.title ?? 'Saved encounter'}
      </Text>
      {item.metadata?.summary ? <Text variant="bodyS">{item.metadata.summary}</Text> : null}
      {withdrawn ? (
        <Text variant="bodyS">This encounter was withdrawn and can't be opened. You can remove it from Keep.</Text>
      ) : (
        <>
          {savedPosition?.kind === 'reel' ? (
            <Text variant="meta">
              Saved place: {Math.floor(savedPosition.positionMs / 60000)}:
              {String(Math.floor(savedPosition.positionMs / 1000) % 60).padStart(2, '0')} · opens paused
            </Text>
          ) : null}
          {savedPosition?.kind === 'scroll' ? <Text variant="meta">Your saved reading place is kept.</Text> : null}
          {place?.status === 'loading' ? <Text variant="meta">Checking saved place…</Text> : null}
          {place?.status === 'unavailable' ? (
            <Text variant="meta">Saved place couldn't be checked. Open details to retry.</Text>
          ) : null}
          {place?.status === 'ready' && place.snapshot?.status === 'not_saved' ? (
            <Text variant="meta">This version is no longer in Keep. Refresh the library.</Text>
          ) : null}
          {place?.status === 'ready' && place.snapshot?.status === 'saved_unavailable' ? (
            <Text variant="meta">This saved version's place isn't available.</Text>
          ) : null}
          {place?.status === 'ready' &&
          place.snapshot?.status === 'available' &&
          place.snapshot.place.status === 'none' ? (
            <Text variant="meta">No saved place yet.</Text>
          ) : null}
          {!place && resume?.kind === 'reel' ? (
            <Text variant="meta">
              On this device: {Math.floor(resume.positionMs / 60000)}:
              {String(Math.floor(resume.positionMs / 1000) % 60).padStart(2, '0')} · opens paused
            </Text>
          ) : !place && resume?.kind === 'scroll' ? (
            <Text variant="meta">Your reading place on this device is kept.</Text>
          ) : null}
          {item.availability === 'corrected' ? (
            <Text variant="bodyS">
              Updated version available. The version you saved stays here until you choose another.
            </Text>
          ) : null}
          <Button
            label={item.availability === 'corrected' ? 'Open original saved version' : 'Open saved encounter'}
            variant="primary"
            disabled={removing}
            onPress={() => onOpen(item.assetRevision)}
          />
          {item.availability === 'corrected' && item.currentAssetRevision !== undefined ? (
            <Button
              label="Open updated version"
              variant="ghost"
              disabled={removing}
              onPress={() => onOpen(item.currentAssetRevision)}
            />
          ) : null}
        </>
      )}
      <Button
        label={failed ? 'Retry removal' : 'Remove from Keep'}
        variant="ghost"
        busy={removing}
        busyLabel="Removing"
        onPress={onRemove}
      />
      {failed ? (
        <Text variant="bodyS">This removal couldn't be completed. Refresh Keep before choosing again.</Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[5],
    borderWidth: 1,
    borderColor: content.ink,
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
});

/** Only the current twenty-card page owns leases; the core admits at most four simultaneous reads. */
export function KeptSavedCard({
  scope,
  ...props
}: React.ComponentProps<typeof SavedCard> & { readonly scope: AccountScope }) {
  const view = useMemo(
    () =>
      createKeepView(
        scope,
        { assetId: props.item.assetId, assetRevision: props.item.assetRevision },
        props.item.savedEntryId,
      ),
    [scope, props.item.assetId, props.item.assetRevision, props.item.savedEntryId],
  );
  useFocusEffect(
    useCallback(() => {
      view.start();
      return () => view.stop();
    }, [view]),
  );
  const place = useSyncExternalStore(view.subscribe, view.getState, view.getState);
  return <SavedCard {...props} place={place} />;
}
