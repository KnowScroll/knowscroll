import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { layout, space, spacing } from '@knowscroll/design-tokens';
import { IconButton, Text } from '@knowscroll/ui';

/**
 * R03's top bar: a dark band (the room's own ground, which the rest of the page is not) with Back and
 * the activity's name. It reaches up under the status bar, so the dark runs to the edge of the screen.
 */
export function ActivityHeader({ title, onBack }: { readonly title: string; readonly onBack: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top + spacing[3] }]} testID="activity-header">
      <IconButton icon="back" label="Back" variant="onSpace" onPress={onBack} />
      <Text variant="ui" heading={1} color={space.label} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[3],
    backgroundColor: space.s0,
  },
  title: { flex: 1 },
});
