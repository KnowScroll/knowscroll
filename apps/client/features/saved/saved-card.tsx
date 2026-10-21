import { StyleSheet, View } from 'react-native';
import type { ListSavedResponse } from '@knowscroll/contracts';
import { content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import type { PrivatePosition } from '../encounter/encounter-history';

type Item = ListSavedResponse['items'][number];
export function SavedCard({
  item,
  resume,
  failed,
  removing,
  onRemove,
  onOpen,
}: {
  readonly item: Item;
  readonly resume?: PrivatePosition;
  readonly failed: boolean;
  readonly removing: boolean;
  readonly onRemove: () => void;
  readonly onOpen: (revision: number) => void;
}) {
  const withdrawn = item.availability === 'withdrawn';
  return (
    <View style={styles.card} testID="saved-encounter-card">
      <Text variant="meta">
        {item.metadata?.kind === 'reel' ? 'Reel' : item.metadata?.kind === 'scroll' ? 'Scroll' : 'Encounter'}
      </Text>
      <Text variant="title" heading={2}>
        {item.metadata?.title ?? 'Saved encounter'}
      </Text>
      {item.metadata?.summary ? <Text variant="bodyS">{item.metadata.summary}</Text> : null}
      {withdrawn ? (
        <Text variant="bodyS">This encounter was withdrawn and can't be opened. You can remove it from Keep.</Text>
      ) : (
        <>
          {resume?.kind === 'reel' ? (
            <Text variant="meta">
              On this device: {Math.floor(resume.positionMs / 60000)}:
              {String(Math.floor(resume.positionMs / 1000) % 60).padStart(2, '0')} · opens paused
            </Text>
          ) : resume?.kind === 'scroll' ? (
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
              onPress={() => onOpen(item.currentAssetRevision!)}
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
      {failed ? <Text variant="bodyS">Couldn't confirm removal. Your saved encounter has been restored.</Text> : null}
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
