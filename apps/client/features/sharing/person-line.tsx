import { StyleSheet, View } from 'react-native';
import type { AvailabilityWord } from '@knowscroll/client-core';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { availabilityLabel } from '../friends/use-availability';

/**
 * The second line of a person in a picker: their availability word with its dot when they show one,
 * and their @handle otherwise (H01). Hidden, expired and unknown availability are one silence, so a
 * person who hides it is indistinguishable from one who is away.
 */
export function PersonLine({ handle, word }: { readonly handle: string; readonly word: AvailabilityWord | undefined }) {
  const label = availabilityLabel(word);
  if (label === undefined)
    return (
      <Text variant="meta" color={content.ink2} numberOfLines={1}>
        @{handle}
      </Text>
    );
  return (
    <View style={styles.line}>
      <View style={[styles.dot, word === 'online' ? styles.online : styles.recent]} aria-hidden />
      <Text variant="metaS" color={content.freshInk} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: borderWidth.light, borderColor: content.fresh },
  online: { backgroundColor: content.fresh },
  recent: { backgroundColor: 'transparent' },
});
