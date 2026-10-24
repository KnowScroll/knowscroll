import { Pressable, StyleSheet } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Text, useFocusRing } from '@knowscroll/ui';
import type { EncounterOrigin } from './encounter-origin';

/**
 * The chip under the top bar that says where this encounter was opened from and returns there
 * (E06 "From the Reel at 0:31 · Back to Reel" in ink, U04 "From <region>" in cream). It is the same action as
 * Back, as a visible target with the place in its name.
 */
export function EncounterOriginChip({
  origin,
  onBack,
}: {
  readonly origin: EncounterOrigin;
  readonly onBack: () => void;
}) {
  const focus = useFocusRing('onLight');
  const paper = origin.tone === 'paper';
  const ink = paper ? content.ink : content.paper;
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`${origin.from}. ${origin.backLabel}`}
      onPress={onBack}
      style={[styles.chip, paper ? styles.paper : null, focus.style]}
    >
      <Icon name={origin.icon ?? 'pause'} size={14} color={ink} />
      <Text variant="uiS" color={ink} numberOfLines={1} style={styles.text}>
        {origin.from} · {origin.backLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: target.comfortable,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: content.ink,
    cursor: 'pointer' as const,
  },
  paper: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  text: { flexShrink: 1 },
});
