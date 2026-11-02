import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import type { NextPartPeek } from './end-tray';

/** How long the bar says where the person's place went: long enough to read, short enough not to sit on the text. */
const BAR_MS = 4_000;

/** The row of a Part with no picture that holds the back tab. */
export const TAB_ROW_HEIGHT = target.minimum + spacing[2];

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
export function PartArrivalBar({
  arrival,
  belowTab = false,
}: {
  readonly arrival: PartArrival;
  /** The back tab has its own row at the top (a Part with no picture): the bar sits under it, not over it. */
  readonly belowTab?: boolean;
}) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), BAR_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View
      style={[styles.barSlot, belowTab ? styles.barSlotBelowTab : null]}
      pointerEvents="none"
      testID="part-arrival-slot"
      role="status"
      accessibilityLiveRegion="polite"
    >
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
 * The tab that goes back to the Part before (V3 F11 "← Part 1"). The swipe right, the ← key and this tab do the same
 * thing; the tab is the one a person can see. With a picture it stands at the picture's left edge. A Part with no picture
 * has no edge to stand on, so the tab takes a row of its own above the text (`inFlow`) and covers none of it.
 */
export function PartBackTab({
  previous,
  inFlow = false,
}: {
  readonly previous: NextPartPeek;
  readonly inFlow?: boolean;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Back to ${previous.label}: ${previous.title}`}
      onPress={previous.onPress}
      style={[styles.tab, inFlow ? styles.tabInFlow : null, focus.style]}
      testID="part-back-tab"
    >
      <Icon name="arrowLeft" size={18} />
      <Text variant="monoXs">{previous.label.toUpperCase()}</Text>
    </Pressable>
  );
}

/** The row the tab takes above a Part's text when there is no picture to stand it on. */
export function PartBackTabRow({ previous }: { readonly previous: NextPartPeek }) {
  return (
    <View style={styles.tabRow} testID="part-back-tab-row">
      <PartBackTab previous={previous} inFlow />
    </View>
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
  barSlotBelowTab: { top: TAB_ROW_HEIGHT + spacing[2] },
  tabRow: { height: TAB_ROW_HEIGHT, alignItems: 'flex-start', justifyContent: 'center' },
  tabInFlow: {
    position: 'relative',
    top: 0,
    flexDirection: 'row',
    minHeight: target.minimum,
    paddingRight: spacing[3],
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
