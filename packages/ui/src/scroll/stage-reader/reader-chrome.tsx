import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { useDisplay } from '../../display/display';
import { IconButton } from '../../actions/icon-button';
import { Text } from '../../text/text';

/**
 * The top bar of a v2 Scroll (D-133): Your Universe at the left with the Scroll's title and its Part ("Part 1 of 3"), the Reel and Scroll switch, and Next ↑ for a new topic in the same format when a
 * swipe does not work. Every move the gestures make has a control here or in the dock.
 */
export function ReaderTopBar({
  title,
  partLabel,
  formatSwitch,
  onUniverse,
  onNextTopic,
}: {
  readonly title: string;
  /** "Part 1 of 3" or "Part 1": counts are real or absent (D-072). */
  readonly partLabel?: string | undefined;
  readonly formatSwitch?: ReactNode;
  readonly onUniverse: () => void;
  readonly onNextTopic?: (() => void) | undefined;
}) {
  const { breakpoint } = useDisplay();
  // A phone has no room for the title beside the switch; it stays the page's heading for a screen reader.
  const room = breakpoint === 'tablet' || breakpoint === 'desktop';
  return (
    <View style={styles.top}>
      <IconButton icon="universe" label="Your Universe" variant="paper" onPress={onUniverse} />
      <View style={room ? styles.where : styles.heading}>
        <Text variant="uiS" heading={1} numberOfLines={1}>
          {title}
        </Text>
        {partLabel === undefined || !room ? null : (
          <Text variant="monoXs" color={content.ink2} numberOfLines={1}>
            {partLabel}
          </Text>
        )}
      </View>
      {room ? null : <View style={styles.where} />}
      {formatSwitch}
      {onNextTopic === undefined ? null : (
        <Button
          label="Next"
          icon="arrowUp"
          iconPosition="trailing"
          size="sm"
          accessibilityLabel="Next topic"
          onPress={onNextTopic}
        />
      )}
    </View>
  );
}

/**
 * The dock at the bottom of a v2 Scroll: Ask, the ••• menu and the next Part. The Part is the one
 * primary action, in the continuation yellow's place; it is absent when no next Part was admitted.
 */
export function ReaderDock({
  onAsk,
  onMore,
  nextPart,
}: {
  readonly onAsk?: (() => void) | undefined;
  readonly onMore?: (() => void) | undefined;
  readonly nextPart?: { readonly label: string; readonly onPress: () => void } | undefined;
}) {
  return (
    <View style={styles.dock}>
      {onAsk === undefined ? null : <Button label="Ask about this" icon="ask" size="sm" onPress={onAsk} />}
      {onMore === undefined ? null : <IconButton icon="more" label="More" variant="paper" size={44} onPress={onMore} />}
      <View style={styles.spacer} />
      {nextPart === undefined ? null : (
        <Button
          label={nextPart.label}
          icon="arrowRight"
          iconPosition="trailing"
          variant="primary"
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
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingBottom: spacing[2],
    backgroundColor: content.paper,
  },
  where: { flex: 1, minWidth: 0 },
  /** Present for assistive technology, drawn in one pixel. */
  heading: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 },
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
  spacer: { flex: 1 },
});
