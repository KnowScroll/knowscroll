import { useEffect, useRef, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { radius, space, spacing, target } from '@knowscroll/design-tokens';
import { Icon, Tag, Text, useFocusRing } from '@knowscroll/ui';

/**
 * The top of a map screen: the Back chip named for where it returns, a small line saying what the screen is, the
 * title, and "Hypothetical" when the place is. On the web focus moves to the title when the screen opens, as the region
 * card's does, so a keyboard or a screen reader starts at what the screen is and Tab reaches the first control next.
 */
export function MapHeader({
  backTo,
  onBack,
  kicker,
  title,
  hypothetical = false,
}: {
  /** Where Back goes, by name: "CI planet 2" (the chip says "Back to CI planet 2" to a screen reader). */
  readonly backTo: string;
  readonly onBack: () => void;
  /** The small line over the title: "A planet in CI system 0" or "A region of CI planet 2". */
  readonly kicker: string;
  readonly title: string;
  readonly hypothetical?: boolean;
}) {
  const headingRef = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const heading = headingRef.current as unknown as HTMLElement | null;
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, []);
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <BackChip backTo={backTo} onPress={onBack} />
      </View>
      <View style={styles.block}>
        <Text variant="label" color={space.label2} testID="map-kicker">
          {kicker}
        </Text>
        <View ref={headingRef} style={styles.heading}>
          <Text variant="displayL" heading={1} color={space.label} style={styles.title} testID="map-title">
            {title}
          </Text>
        </View>
        {hypothetical ? <Tag label="Hypothetical" variant="hypothetical" /> : null}
      </View>
    </View>
  );
}

/**
 * The cream Back pill of the Universe's header (`SpaceChip`, solid), at 48 px: that chip is 44, and a map's Back is its
 * one way out. The name shortens with an ellipsis; a screen reader hears it whole.
 */
function BackChip({ backTo, onPress }: { backTo: string; onPress: () => void }) {
  const focus = useFocusRing('onDark');
  return (
    <Pressable
      testID="map-back"
      accessibilityRole="button"
      accessibilityLabel={`Back to ${backTo}`}
      onPress={onPress}
      {...focus.props}
      style={[styles.chip, focus.style]}
    >
      <Icon name="back" size={16} color={space.onControl} strokeWidth={2.2} />
      <View style={styles.chipLabel}>
        <Text variant="uiS" color={space.onControl} numberOfLines={1}>
          {backTo}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing[3] },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: target.comfortable,
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: space.control,
    maxWidth: '100%',
    flexShrink: 1,
    cursor: 'pointer' as const,
  },
  chipLabel: { flexShrink: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  block: { gap: 2, alignItems: 'flex-start' },
  /** Focus lands here when the screen opens; a heading is not a control, so the browser's ring is not drawn on it. */
  heading: { outlineStyle: 'none' as never },
  title: { fontSize: 30, lineHeight: 34 },
});
