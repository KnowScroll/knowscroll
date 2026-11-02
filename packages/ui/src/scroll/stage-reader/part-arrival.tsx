import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import type { NextPartPeek } from './end-tray';

/** How long the bar says where the person's place went: long enough to read, short enough not to sit on the text. */
const BAR_MS = 4_000;

/** What the reader says when it was opened by a move to the next Part. */
export interface PartArrival {
  /** The Part now on screen: "Part 2". */
  readonly part: string;
  /** The Part left behind, whose place is kept: "Part 1". */
  readonly from: string;
}

/**
 * "Part 2 · your place in Part 1 is kept" (V3 G2, F11): said once when a Part opens from the one before, over the top of
 * the text, and gone after a few seconds. It is true because the Part left is kept as it was (Back and "← Part 1" return
 * to the same stop). A polite status, so a screen reader hears it once; it has nothing to press.
 */
export function PartArrivalBar({ arrival }: { readonly arrival: PartArrival }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), BAR_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={styles.barSlot} pointerEvents="none" role="status" accessibilityLiveRegion="polite">
      {shown ? (
        <View style={styles.bar} testID="part-arrival">
          <Text variant="uiS" color={content.paper}>
            {`${arrival.part} · your place in ${arrival.from} is kept`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The tab at the left edge of the picture that goes back to the Part before (V3 F11 "← Part 1"). The swipe right, the ←
 * key and this tab do the same thing; the tab is the one a person can see.
 */
export function PartBackTab({ previous }: { readonly previous: NextPartPeek }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${previous.label}: ${previous.title}`}
      onPress={previous.onPress}
      style={[styles.tab, focus.style]}
      testID="part-back-tab"
    >
      <Icon name="arrowLeft" size={18} />
      <Text variant="monoXs">{previous.label.toUpperCase()}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  barSlot: { position: 'absolute', top: spacing[2], left: spacing[4], right: spacing[4], alignItems: 'center' },
  bar: {
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: content.ink,
  },
  tab: {
    position: 'absolute',
    left: 0,
    top: '35%',
    minWidth: target.minimum,
    minHeight: target.minimum + spacing[4],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    borderTopRightRadius: radius.card,
    borderBottomRightRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderLeftWidth: 0,
    borderColor: content.ink,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
});
