import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { IconButton } from '../../actions/icon-button';
import { useDisplay } from '../../display/display';
import { Text, useTypeStyle } from '../../text/text';
import type { NextPartPeek } from './end-tray';
import { SparkChip } from './play-chips';

/**
 * The top bar of a v2 Scroll (D-133, D-185): Your Universe at the left, the Scroll's title with its
 * kicker and Part ("SEASONS · Part 1 of 3") beside it, the Reel and Scroll switch, and Next ↑ for a new
 * topic in the same format when a swipe does not work. Every move the gestures make has a control here
 * or in the dock. Next says its word wherever the bar has the room (V3 P3, G1): always from tablet width, and on a
 * phone from 361 px up when the title still fits beside it on one line of controls. Where it would push the switch
 * and Next under the title, and always at 320 to 360 px, Next is its arrow alone, which keeps the bar to one line
 * and leaves the text its height (D-185). Where even the arrow leaves the title under 84 px the switch and Next
 * wrap to a second line. A title is cut to two lines (its whole text stays in the page for a screen reader),
 * never hidden, and no control is clipped.
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
  const { breakpoint } = useDisplay();
  const wide = breakpoint === 'tablet' || breakpoint === 'desktop';
  const roomForWord = useRoomForNextWord(`${title}|${breakpoint}`);
  const showWord = wide || (breakpoint === 'phone' && roomForWord.fits);
  // While the word is tried on a phone the title may be squeezed further than usual: it must still fit its two lines.
  const trying = !wide && showWord;
  const where = [kicker, partLabel].filter((part) => part !== undefined && part !== '').join(' · ');
  return (
    <View style={styles.top} testID="reader-top-bar">
      <IconButton icon="universe" label="Your Universe" variant="paper" onPress={onUniverse} />
      <View
        style={[styles.where, trying ? styles.whereTrying : null]}
        onLayout={roomForWord.onWhereLayout}
        testID="reader-top-title"
      >
        <Text variant="uiS" heading={1} numberOfLines={2}>
          {title}
        </Text>
        {trying ? <TitleProbe title={title} onHeight={roomForWord.onProbeHeight} /> : null}
        {where === '' ? null : (
          <Text variant="monoXs" color={content.ink2} numberOfLines={2}>
            {where}
          </Text>
        )}
      </View>
      <View style={styles.controls} onLayout={roomForWord.onControlsLayout} testID="reader-top-controls">
        {formatSwitch}
        {onNextTopic === undefined ? null : showWord ? (
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
 * Whether Next may say its word beside this title on a phone. The bar is laid out with the word first, and the word
 * is taken back for this title and width when the controls have wrapped under the title (they sit wholly below it) or
 * the title no longer fits its two lines in the room that is left. A layout that has not been measured yet counts as
 * fitting.
 */
function useRoomForNextWord(key: string) {
  const [lostFor, setLostFor] = useState<string | undefined>();
  const lineHeight = useTypeStyle('uiS').lineHeight;
  const where = useRef<{ readonly y: number; readonly height: number } | undefined>(undefined);
  const controls = useRef<number | undefined>(undefined);
  const probe = useRef<number | undefined>(undefined);
  // Layout events report only what changed, so each one is judged against the last known position of the others.
  const judge = () => {
    const wrapped =
      where.current !== undefined &&
      controls.current !== undefined &&
      controls.current >= where.current.y + where.current.height - 1;
    const tooTall = probe.current !== undefined && probe.current > lineHeight * 2 + 2;
    if (wrapped || tooTall) setLostFor(key);
  };
  return {
    fits: lostFor !== key,
    onWhereLayout: (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      where.current = { y, height };
      judge();
    },
    onControlsLayout: (event: LayoutChangeEvent) => {
      controls.current = event.nativeEvent.layout.y;
      judge();
    },
    onProbeHeight: (height: number) => {
      probe.current = height;
      judge();
    },
  };
}

/** The title at the width the bar gives it, uncut and unseen: its height says how many lines it needs. */
function TitleProbe({ title, onHeight }: { readonly title: string; readonly onHeight: (height: number) => void }) {
  return (
    <View
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.probe}
      testID="reader-top-title-probe"
      onLayout={(event) => onHeight(event.nativeEvent.layout.height)}
    >
      <Text variant="uiS">{title}</Text>
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
          icon="sparkle"
          iconColor={content.accent}
          variant="tint"
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
  /** While Next's word is tried the title may take less; the probe tells whether it still fits. */
  whereTrying: { minWidth: 56 },
  probe: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0 },
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
