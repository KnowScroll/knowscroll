import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';

/**
 * The end of the article: a diamond between two rules (E02-3). It is a boundary, not a launch
 * pad: reaching it starts nothing. Assistive technology hears where the article ends.
 */
export function EndMark() {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="End of this Scroll" style={styles.mark}>
      <View style={styles.rule} />
      <View style={styles.diamond} />
      <View style={styles.rule} />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing['2.5'],
    paddingVertical: spacing[6],
  },
  rule: { width: spacing[12], height: 2, backgroundColor: content.ink },
  diamond: { width: 10, height: 10, backgroundColor: content.ink, transform: [{ rotate: '45deg' }] },
});
