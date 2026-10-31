import { StyleSheet, View } from 'react-native';
import { borderWidth, dimension, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { useBandTone } from './band-tone';

/**
 * A plain label on a room's band: the kit's ink on its ground, with a hairline edge. The shared dark-header tag is cream
 * on the dark space ground, which would vanish on a light kit, so a band draws its labels in its own ink.
 */
export function BandTag({ label, testID }: { readonly label: string; readonly testID?: string }) {
  const tone = useBandTone();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.tag, { borderColor: tone.edge }]}
    >
      <Text variant="label" color={tone.ink}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    alignSelf: 'flex-start',
    justifyContent: 'center',
    minHeight: dimension.tagHeight,
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
  },
});
