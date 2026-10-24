import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AccountScope, KeepPlaceState } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { BottomSheet, Button, IconButton, Tag, Text } from '@knowscroll/ui';
import type { PrivatePosition } from '../encounter/encounter-history';
import { KeepThumb } from './keep-thumb';
import { createKeepView } from './keep-place-bridge';
import { positionLine } from './keep-position';
import type { SavedItem } from './saved-query';

/**
 * One kept encounter (S01): a thumbnail, what it is, and where you left off. The card is one
 * button named by its title, format and place. Corrected and withdrawn items say so plainly;
 * a withdrawn one cannot be opened and offers only Remove, drawn on the card. On every other
 * card Remove is in the ⋯ menu, as the design has it; a removal that failed shows Retry removal on
 * the card, because a failure must not hide behind a menu.
 */
export function SavedCard({
  item,
  resume,
  place,
  failed,
  removing,
  onRemove,
  onOpen,
}: {
  readonly item: SavedItem;
  readonly resume?: PrivatePosition;
  readonly place?: KeepPlaceState;
  readonly failed: boolean;
  readonly removing: boolean;
  readonly onRemove: () => void;
  readonly onOpen: (revision: number) => void;
}) {
  const withdrawn = item.availability === 'withdrawn';
  const corrected = item.availability === 'corrected';
  const format = item.kind === 'reel' ? 'Reel' : 'Scroll';
  const title = item.metadata?.title ?? 'Saved encounter';
  const line = positionLine(item, place, resume);
  const [menuOpen, setMenuOpen] = useState(false);
  const removeOnCard = withdrawn || failed;
  return (
    <View
      testID="saved-encounter-card"
      style={[styles.card, withdrawn ? styles.withdrawn : null, corrected ? styles.corrected : null]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${format}. ${line}`}
        disabled={withdrawn || removing}
        aria-disabled={withdrawn || removing}
        onPress={() => onOpen(item.assetRevision)}
        style={styles.row}
      >
        <KeepThumb kind={item.kind} withdrawn={withdrawn} />
        <View style={styles.copy}>
          <Tag
            label={withdrawn ? 'No longer available' : corrected ? 'Updated' : format}
            variant={corrected ? 'corrected' : 'neutral'}
          />
          <Text variant="ui" numberOfLines={3}>
            {title}
          </Text>
          <Text variant="meta" color={content.ink2}>
            {line}
          </Text>
        </View>
      </Pressable>
      {removeOnCard || (corrected && item.currentAssetRevision !== undefined) ? (
        <View style={styles.actions}>
          {corrected && item.currentAssetRevision !== undefined ? (
            <Button
              label="Open updated version"
              size="sm"
              disabled={removing}
              onPress={() => onOpen(item.currentAssetRevision)}
            />
          ) : null}
          {removeOnCard ? (
            <Button
              label={failed ? 'Retry removal' : 'Remove from Keep'}
              size="sm"
              variant={withdrawn ? 'default' : 'ghost'}
              busy={removing}
              busyLabel="Removing"
              onPress={onRemove}
            />
          ) : null}
        </View>
      ) : null}
      {withdrawn ? null : (
        <View style={styles.more}>
          <IconButton
            icon="more"
            label={`More for ${title}`}
            variant="paper"
            disabled={removing}
            onPress={() => setMenuOpen(true)}
          />
        </View>
      )}
      <BottomSheet visible={menuOpen} title={title} onClose={() => setMenuOpen(false)}>
        <Button
          label="Remove from Keep"
          variant="ghost"
          fullWidth
          onPress={() => {
            setMenuOpen(false);
            onRemove();
          }}
        />
      </BottomSheet>
    </View>
  );
}

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

const styles = StyleSheet.create({
  card: {
    position: 'relative',
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  withdrawn: { borderStyle: 'dashed', backgroundColor: content.paper2 },
  corrected: { borderColor: status.corrected.edge },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 72, cursor: 'pointer' as const },
  copy: { flex: 1, gap: spacing['1.5'], alignItems: 'flex-start' },
  more: { position: 'absolute', top: spacing[2], right: spacing[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], justifyContent: 'flex-end' },
});
