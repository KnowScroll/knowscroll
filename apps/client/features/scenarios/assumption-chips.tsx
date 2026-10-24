import { StyleSheet, View } from 'react-native';
import { chipText, describeOption } from '@knowscroll/client-core';
import type { ScenarioOption } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/** What an idea changes (dashed cobalt), keeps (ink) or looks through, as chips that wrap on a narrow screen. */
export function AssumptionChips({ option }: { readonly option: Pick<ScenarioOption, 'changes' | 'kept' | 'lens'> }) {
  return (
    <View style={styles.chips} accessibilityLabel={describeOption(option)}>
      {option.lens === undefined ? null : (
        <View style={[styles.chip, styles.changed]}>
          <Text variant="uiS" color={status.hypothetical.foreground}>
            Lens: {option.lens}
          </Text>
        </View>
      )}
      {option.changes.map((change) => (
        <View key={`c-${change.subject}`} style={[styles.chip, styles.changed]}>
          <Text variant="uiS" color={status.hypothetical.foreground}>
            {chipText('Changed', change)}
          </Text>
        </View>
      ))}
      {option.kept.map((keep) => (
        <View key={`k-${keep.subject}`} style={styles.chip}>
          <Text variant="uiS">{chipText('Kept', keep)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.card,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
  },
  changed: { borderStyle: 'dashed', borderColor: status.hypothetical.edge },
});
