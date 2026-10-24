import { StyleSheet, View } from 'react-native';
import { chipText, describeOption, replacedPremises } from '@knowscroll/client-core';
import type { Assumption, ScenarioOption } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/**
 * What an idea changes (dashed cobalt), what it takes out (dashed grey, "Replaces: …", in the premise's own words)
 * and what it keeps (ink) or looks through, as chips that wrap on a narrow screen. `premises` are those of the branch
 * it continues: with them the member sees every premise the idea would drop before they choose it.
 */
export function AssumptionChips({
  option,
  premises = [],
}: {
  readonly option: Pick<ScenarioOption, 'changes' | 'kept' | 'lens'>;
  readonly premises?: readonly Assumption[];
}) {
  return (
    <View style={styles.chips} accessibilityLabel={describeOption(option, premises)}>
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
      {replacedPremises(option, premises).map((premise) => (
        <View key={`r-${premise.subject}`} style={[styles.chip, styles.replaced]}>
          <Text variant="uiS" color={content.ink2}>
            {chipText('Replaces', premise)}
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
  replaced: { borderStyle: 'dashed', borderColor: content.muted, backgroundColor: content.paper2 },
});
