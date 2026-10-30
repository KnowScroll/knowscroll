import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, radius, spacing, status, universe } from '@knowscroll/design-tokens';
import { IconButton } from '../actions/icon-button';
import { useFocusRing } from '../display/focus-ring';
import { Text } from '../text/text';
import { useTalkTheme } from './talk-theme';

/** Radius of a bubble, and of the corner that carries the tail on the last bubble of a run (T3 kit). */
const BUBBLE_RADIUS = 20;
const TAIL_RADIUS = 4;
/** The widest a bubble grows (T3: max 272 px), so lines stay short on a desktop. */
const BUBBLE_MAX_WIDTH = 272;

/** Glass blurs what is behind it on the web; elsewhere the fill alone is drawn. */
const glassBlur = (): ViewStyle =>
  Platform.OS === 'web'
    ? ({
        backdropFilter: `blur(${String(universe.glass.blur)}px) saturate(${String(universe.glass.saturate)})`,
      } as ViewStyle)
    : {};

export interface TalkBubbleProps {
  readonly mine: boolean;
  /** The last bubble of a run carries the tail: one corner is squared (T3 kit). */
  readonly tail?: boolean;
  /** Just jumped to from a quote: the highlight fill, or a 2 px outline when motion is reduced. */
  readonly flash?: 'fill' | 'outline' | undefined;
  /** A message that did not go: paper with a danger edge, so it never reads as sent. */
  readonly failed?: boolean;
  readonly children: ReactNode;
  readonly testID?: string;
}

/**
 * A message bubble in the Talk theme: paper and ink for other people, cobalt for you, both with the
 * chunky offset shadow. It draws the surface only; its words and any quote are children.
 */
export function TalkBubble({ mine, tail = true, flash, failed = false, children, testID }: TalkBubbleProps) {
  const theme = useTalkTheme();
  const look = mine && !failed ? theme.bubbleOwn : theme.bubbleOther;
  const squared: ViewStyle = mine ? { borderBottomRightRadius: TAIL_RADIUS } : { borderBottomLeftRadius: TAIL_RADIUS };
  return (
    <View
      testID={testID}
      style={[
        styles.bubble,
        tail ? squared : null,
        {
          backgroundColor: flash === 'fill' ? theme.flash : look.fill,
          boxShadow: look.shadow,
          borderColor: failed ? status.danger.edge : flash === 'outline' ? theme.focus : look.edge,
          borderWidth:
            failed || flash === 'outline'
              ? borderWidth.regular
              : look.edge === 'transparent'
                ? 0
                : borderWidth.hairline,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * A day's capsule: glass over the sky, one per day ("TODAY", "YESTERDAY", "SUN 26 OCT"). A heading, so
 * a screen reader can move between days.
 */
export function DateCapsule({ label }: { readonly label: string }) {
  const theme = useTalkTheme();
  return (
    <View
      style={[styles.capsule, { backgroundColor: theme.capsule.fill, borderColor: theme.capsule.edge }, glassBlur()]}
    >
      <Text variant="monoXs" heading={2} color={theme.capsule.text} align="center">
        {label}
      </Text>
    </View>
  );
}

export interface QuoteStripProps {
  /** Which bubble the strip sits in: it takes that bubble's quote colours. */
  readonly onOwnBubble: boolean;
  /** Who wrote the original, or nothing once it was removed. */
  readonly author: string | undefined;
  readonly preview: string;
  /** Jumps to the original and flashes it. Absent when the original is gone: the strip says so and does not jump. */
  readonly onJump: (() => void) | undefined;
  /** A long press on the strip is a long press on the bubble: it opens the message menu. */
  readonly onLongPress?: (() => void) | undefined;
}

/**
 * The quote inside a reply bubble (T3 kit): a 4 px cobalt bar, the author and one line of the
 * original. It is a button that jumps to the original; if that was removed it says so and does not.
 */
export function QuoteStrip({ onOwnBubble, author, preview, onJump, onLongPress }: QuoteStripProps) {
  const theme = useTalkTheme();
  const look = onOwnBubble ? theme.quoteOnOwn : theme.quoteOnOther;
  const focus = useFocusRing('onLight');
  const removed = author === undefined;
  const label = removed
    ? 'Reply to a message that was removed'
    : `Reply to ${author}: ${preview}. Go to the original message`;
  const body = (
    <>
      <View style={[styles.quoteBar, { backgroundColor: look.bar }]} />
      <View style={styles.quoteWords}>
        <Text variant="metaS" color={look.text} numberOfLines={1}>
          {removed ? 'Original message removed' : author}
        </Text>
        {removed ? null : (
          <Text variant="meta" color={look.text} numberOfLines={1}>
            {preview === '' ? 'A shared Reel or Scroll' : preview}
          </Text>
        )}
      </View>
    </>
  );
  if (onJump === undefined)
    return (
      <View
        accessible
        accessibilityLabel={label}
        style={[styles.quote, { backgroundColor: look.fill }]}
        testID="quote-strip"
      >
        {body}
      </View>
    );
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onJump}
      onLongPress={onLongPress}
      delayLongPress={400}
      style={[styles.quote, { backgroundColor: look.fill }, focus.style]}
      testID="quote-strip"
    >
      {body}
    </Pressable>
  );
}

export interface ReplyChipProps {
  readonly author: string;
  readonly preview: string;
  readonly onCancel: () => void;
}

/** "Replying to Ravi" above the message box: a cobalt bar, the sender and one line; ✕ or Esc cancels (T3 kit). */
export function ReplyChip({ author, preview, onCancel }: ReplyChipProps) {
  const theme = useTalkTheme();
  return (
    <View
      style={[styles.chip, { backgroundColor: theme.input.fill }]}
      accessibilityLiveRegion="polite"
      testID="reply-chip"
    >
      <View style={[styles.quoteBar, { backgroundColor: theme.quoteOnOther.bar }]} />
      <View style={styles.quoteWords}>
        <Text variant="metaS" color={theme.input.text} numberOfLines={1}>
          {`Replying to ${author}`}
        </Text>
        <Text variant="meta" color={theme.input.placeholder} numberOfLines={1}>
          {preview === '' ? 'A shared Reel or Scroll' : preview}
        </Text>
      </View>
      <IconButton icon="close" label="Cancel reply" variant="plain" size={44} onPress={onCancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    maxWidth: BUBBLE_MAX_WIDTH,
    borderRadius: BUBBLE_RADIUS,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing['2.5'],
    gap: spacing[2],
  },
  capsule: {
    alignSelf: 'center',
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  quote: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing[2],
    borderRadius: radius.md,
    overflow: 'hidden',
    paddingRight: spacing[2],
    minHeight: 40,
  },
  quoteBar: { width: 4, borderRadius: 2 },
  quoteWords: { flexShrink: 1, flexGrow: 1, paddingVertical: spacing[1], gap: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    borderRadius: radius.lg,
    paddingLeft: spacing[3],
    paddingVertical: spacing[1],
    minHeight: 52,
  },
});
