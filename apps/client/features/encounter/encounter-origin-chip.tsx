import { Pressable, StyleSheet } from 'react-native';
import { content, radius, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Text, useFocusRing } from '@knowscroll/ui';
import type { EncounterOrigin } from './encounter-origin';

/**
 * The dark chip under the top bar that says where this encounter was opened from and returns
 * there (E06 "From the Reel at 0:31 · Back to Reel", U04 "From <region>"). It is the same action as
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
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`${origin.from}. ${origin.backLabel}`}
      onPress={onBack}
      style={[styles.chip, focus.style]}
    >
      <Icon name={origin.icon ?? 'pause'} size={14} color={content.paper} />
      <Text variant="uiS" color={content.paper} numberOfLines={1} style={styles.text}>
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
  text: { flexShrink: 1 },
});
