import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { IconButton } from '../../actions/icon-button';
import { useDisplay } from '../../display/display';
import { Text } from '../../text/text';
import type { NextPartPeek } from './end-tray';
import { SparkChip } from './play-chips';

/**
 * The top bar of a v2 Scroll (D-133, D-185): Your Universe at the left, the Scroll's title with its
 * kicker and Part ("SEASONS · Part 1 of 3") beside it, the Reel and Scroll switch, and Next ↑ for a new
 * topic in the same format when a swipe does not work. Every move the gestures make has a control here
 * or in the dock. On a phone Next is its arrow alone, which keeps the bar to one line at 390 px and leaves
 * the text its height. Where the title would be left under 84 px (320 to 360 px) the switch and Next wrap to a
 * second line. A title is cut to two lines (its whole text stays in the page for a screen reader), never hidden,
 * and no control is clipped.
 */
export function ReaderTopBar({
  title,
  kicker,
  partLabel,
  formatSwitch,
  onUniverse,
  onNextTopic,
}: {
  readonly title: string;
  /** The Scroll's own kicker ("Seasons"). */
  readonly kicker?: string | undefined;
  /** "Part 1 of 3" or "Part 1": counts are real or absent (D-072). */
  readonly partLabel?: string | undefined;
  readonly formatSwitch?: ReactNode;
  readonly onUniverse: () => void;
  readonly onNextTopic?: (() => void) | undefined;
}) {
  // Below tablet width Next is its arrow alone, so the bar stays one line at 390 px (the reader keeps its height).
  const { breakpoint } = useDisplay();
  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';
  const where = [kicker, partLabel].filter((part) => part !== undefined && part !== '').join(' · ');
  return (
    <View style={styles.top} testID="reader-top-bar">
      <IconButton icon="universe" label="Your Universe" variant="paper" onPress={onUniverse} />
      <View style={styles.where}>
        <Text variant="uiS" heading={1} numberOfLines={2}>
          {title}
        </Text>
        {where === '' ? null : (
          <Text variant="monoXs" color={content.ink2} numberOfLines={2}>
            {where}
          </Text>
        )}
      </View>
      <View style={styles.controls}>
        {formatSwitch}
        {onNextTopic === undefined ? null : wide ? (
          <Button
            label="Next"
            icon="arrowUp"
            iconPosition="trailing"
            size="sm"
            accessibilityLabel="Next topic"
            onPress={onNextTopic}
          />
        ) : (
          <IconButton icon="arrowUp" label="Next topic" variant="paper" size={44} onPress={onNextTopic} />
        )}
      </View>
    </View>
  );
}

/**
 * The dock at the bottom of a v2 Scroll: Ask, the sparks earned on this Scroll, the ••• menu and the
 * way on. The way on is the one primary action, in the continuation yellow's place: the next Part, or,
 * where there is none, the related move (D-184). It is absent when neither was admitted. The sparks are
 * this Scroll's alone, never a total (D-064).
 */
export function ReaderDock({
  onAsk,
  sparks,
  onMore,
  nextPart,
}: {
  readonly onAsk?: (() => void) | undefined;
  /** Sparks earned on this Scroll; the chip is absent when play is not on this screen. */
  readonly sparks?: number | undefined;
  readonly onMore?: (() => void) | undefined;
  readonly nextPart?: NextPartPeek | undefined;
}) {
  // At 320 to 359 px the four controls do not fit in a row with the full wording, so Ask drops to its first word; its name does not change.
  const { breakpoint } = useDisplay();
  const compact = breakpoint === 'compact';
  return (
    <View style={[styles.dock, compact ? styles.dockCompact : null]}>
      {onAsk === undefined ? null : (
        <Button
          label={compact ? 'Ask' : 'Ask about this'}
          accessibilityLabel="Ask about this"
          icon="ask"
          size="sm"
          onPress={onAsk}
        />
      )}
      {sparks === undefined ? null : <SparkChip sparks={sparks} />}
      {onMore === undefined ? null : <IconButton icon="more" label="More" variant="paper" size={44} onPress={onMore} />}
      <View style={styles.spacer} />
      {nextPart === undefined ? null : (
        <Button
          label={nextPart.label}
          accessibilityLabel={`${nextPart.label}: ${nextPart.title}`}
          icon="arrowRight"
          iconPosition="trailing"
          variant={nextPart.related === true ? 'default' : 'primary'}
          dashed={nextPart.related === true}
          size="sm"
          onPress={nextPart.onPress}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[2],
    rowGap: spacing[1],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[2],
    backgroundColor: content.paper,
  },
  /** Takes what the Universe button and the controls leave; below 84 px the controls wrap to their own line. */
  where: { flex: 1, minWidth: 84 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], marginLeft: 'auto', maxWidth: '100%' },
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    borderTopWidth: borderWidth.regular,
    borderTopColor: content.ink,
    backgroundColor: content.paper,
  },
  dockCompact: { gap: spacing[1], paddingHorizontal: spacing[3] },
  spacer: { flex: 1 },
});
