import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { IconButton } from '../../actions/icon-button';
import { useDisplay } from '../../display/display';
import type { IconName } from '../../icons/icon-paths';
import { Text, useTypeStyle } from '../../text/text';
import type { NextPartPeek } from './reader-commands';

/**
 * The top bar of a v2 Scroll (D-133, D-185): Back for a standalone reader, otherwise Your Universe at the left, the title with its
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
  onBack,
  onNextTopic,
}: {
  readonly title: string;
  /** The Scroll's own kicker ("Seasons"). */
  readonly kicker?: string | undefined;
  /** "Part 1 of 3" or "Part 1": counts are real or absent (D-072). */
  readonly partLabel?: string | undefined;
  readonly formatSwitch?: ReactNode;
  readonly onUniverse: () => void;
  /** Return to the screen that opened this reader; omitted in Explore, where the Universe control stays. */
  readonly onBack?: (() => void) | undefined;
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
      {onBack === undefined ? (
        <IconButton icon="universe" label="Your Universe" variant="paper" onPress={onUniverse} />
      ) : (
        <IconButton icon="back" label="Back" variant="paper" onPress={onBack} />
      )}
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

/** Below this width the dock closes its gaps so that Like, Share, Save, ••• and the way on fit in a row. */
const NARROW_PHONE = 400;

/** Like or Save as the dock offers it: a two-state control that keeps its word when pressed. */
export interface DockToggle {
  readonly on: boolean;
  /** A command is in flight (Save, Like): presses are ignored. */
  readonly busy?: boolean | undefined;
  readonly onPress: () => void;
}

/**
 * Share as the dock offers it, never a dead button: a moment when the stop on screen can be shared as one, otherwise the
 * whole Scroll. `what` says which, so the name says what pressing will do; the word on the button stays "Share".
 */
export interface DockShare {
  readonly onPress: () => void;
  readonly what: 'moment' | 'scroll';
}

/** One dock action: its glyph in a 44 px target with its word beneath, small, which repeats the name for the eye alone. */
function DockAction({
  icon,
  word,
  name,
  pressed,
  busy,
  onPress,
  testID,
}: {
  readonly icon: IconName;
  readonly word: string;
  readonly name: string;
  readonly pressed?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly onPress: () => void;
  readonly testID: string;
}) {
  return (
    <View style={styles.action}>
      <IconButton
        icon={icon}
        label={name}
        variant="paper"
        size={44}
        pressed={pressed}
        busy={busy}
        onPress={onPress}
        testID={testID}
      />
      <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text variant="uiLabel" color={content.ink}>
          {word}
        </Text>
      </View>
    </View>
  );
}

/**
 * The dock at the bottom of a v2 Scroll (D-429): ♡ Like, Share and Save at the start, ••• and the way on at the end. The way on is the one
 * primary action, in the continuation yellow's place: the next Part (D-184, D-425), absent when none was admitted. Ask is
 * the first row of the ••• sheet (and the A and ? keys). A control the screen cannot do is left out (a thread's reader
 * keeps no Save and has no Like); Share is never disabled: it shares the stop on screen as a moment where it can, and
 * otherwise the whole Scroll, and its name says which.
 * The words are those of the encounter actions (D-006 b), a toggle keeps its word when pressed and announces its state.
 */
export function ReaderDock({
  like,
  share,
  save,
  onMore,
  nextPart,
}: {
  readonly like?: DockToggle | undefined;
  readonly share?: DockShare | undefined;
  readonly save?: DockToggle | undefined;
  readonly onMore?: (() => void) | undefined;
  readonly nextPart?: NextPartPeek | undefined;
}) {
  // At 360 px and under the gaps close up, and under 400 the page margin does; each control stays 44 px and keeps its word.
  // With large text the words grow with it and the row wraps (the way on to a row of its own), so no control is clipped
  // or squeezed under 44 px.
  const { breakpoint, width } = useDisplay();
  const compact = breakpoint === 'compact';
  const shareName = share?.what === 'scroll' ? 'Share this Scroll' : 'Share a moment';
  return (
    <View
      testID="reader-dock"
      role="group"
      accessibilityLabel="Scroll actions"
      style={[styles.dock, compact ? styles.dockCompact : width < NARROW_PHONE ? styles.dockNarrow : null]}
    >
      {like === undefined ? null : (
        <DockAction
          icon="like"
          word="Like"
          name="Like"
          pressed={like.on}
          busy={like.busy}
          onPress={like.onPress}
          testID="dock-like"
        />
      )}
      {share === undefined ? null : (
        <DockAction icon="share" word="Share" name={shareName} onPress={share.onPress} testID="dock-share" />
      )}
      {save === undefined ? null : (
        <DockAction
          icon="save"
          word="Save"
          name="Save"
          pressed={save.on}
          busy={save.busy}
          onPress={save.onPress}
          testID="dock-save"
        />
      )}
      <View style={styles.spacer} />
      {onMore === undefined ? null : (
        <DockAction icon="more" word="More" name="More" onPress={onMore} testID="dock-more" />
      )}
      {nextPart === undefined ? null : (
        <View style={styles.wayOn}>
          <Button
            label={nextPart.label}
            accessibilityLabel={`${nextPart.label}: ${nextPart.title}`}
            icon="arrowRight"
            iconPosition="trailing"
            variant="primary"
            size="sm"
            onPress={nextPart.onPress}
          />
        </View>
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
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    borderTopWidth: borderWidth.regular,
    borderTopColor: content.ink,
    backgroundColor: content.paper,
  },
  dockCompact: { gap: spacing[1], paddingHorizontal: spacing[3] },
  dockNarrow: { gap: spacing[1] },
  /** Where the row wraps (large text), the way on keeps to the end of whichever row it lands on. */
  wayOn: { marginLeft: 'auto' },
  action: { alignItems: 'center', gap: 2 },
  spacer: { flex: 1 },
});
