import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { toggleSemantics } from '../display/semantics';
import { Text } from '../text/text';
import { ReactionGlyph, REACTION_KINDS, REACTION_LABELS, type ReactionKind } from './reaction-glyph';
import { useTalkTheme } from './talk-theme';

export interface ReactionPillProps {
  readonly kind: ReactionKind;
  /** How many people put this reaction on the message. */
  readonly count: number;
  /** One of them is the reader: the pill carries a cobalt outline. */
  readonly mine: boolean;
  /** "Tap to see who" (T3 kit). */
  readonly onPress: () => void;
}

/**
 * A reaction under a bubble: the drawn glyph and how many people chose it. Pressing it lists who.
 * "Spark, 2 people, including you" is its whole name, so a screen reader needs no glyph.
 */
export function ReactionPill({ kind, count, mine, onPress }: ReactionPillProps) {
  const theme = useTalkTheme();
  const focus = useFocusRing('onDark');
  const people = count === 1 ? '1 person' : `${String(count)} people`;
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`${REACTION_LABELS[kind]}, ${people}${mine ? ', including you' : ''}`}
      accessibilityHint="Shows who reacted"
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      testID={`reaction-pill-${kind}`}
      style={[
        styles.pill,
        {
          backgroundColor: theme.pill.fill,
          borderColor: mine ? theme.pill.mine : theme.pill.edge,
          borderWidth: mine ? borderWidth.regular : theme.pill.edge === 'transparent' ? 0 : borderWidth.hairline,
        },
        focus.style,
      ]}
    >
      <ReactionGlyph kind={kind} size={16} />
      <Text variant="uiS" color={theme.pill.text}>
        {String(count)}
      </Text>
    </Pressable>
  );
}

export interface ReactionBarProps {
  /** The reactions the reader already has on this message: pressed, and pressing one takes it back. */
  readonly held: ReadonlySet<ReactionKind>;
  readonly onPick: (kind: ReactionKind) => void;
}

/**
 * The five reactions in a row, on the long-press menu (T3 kit). Each is a toggle button named by its
 * word; there is no emoji keyboard. Pressing one you hold takes it back.
 */
export function ReactionBar({ held, onPick }: ReactionBarProps) {
  const theme = useTalkTheme();
  return (
    <View
      role="group"
      accessibilityLabel="React"
      style={[styles.bar, { backgroundColor: theme.menu.fill }]}
      testID="reaction-bar"
    >
      {REACTION_KINDS.map((kind) => (
        <ReactionChoice key={kind} kind={kind} pressed={held.has(kind)} onPress={() => onPick(kind)} />
      ))}
    </View>
  );
}

function ReactionChoice({
  kind,
  pressed,
  onPress,
}: {
  readonly kind: ReactionKind;
  readonly pressed: boolean;
  readonly onPress: () => void;
}) {
  const theme = useTalkTheme();
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...toggleSemantics(pressed)}
      accessibilityLabel={REACTION_LABELS[kind]}
      onPress={onPress}
      testID={`react-${kind}`}
      style={[
        styles.choice,
        pressed
          ? { backgroundColor: theme.menu.rule, borderColor: theme.pill.mine, borderWidth: borderWidth.regular }
          : null,
        focus.style,
      ]}
    >
      <ReactionGlyph kind={kind} size={24} />
      <Text variant="uiLabel" color={theme.menu.text} numberOfLines={1}>
        {REACTION_LABELS[kind]}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    minHeight: 28,
    paddingHorizontal: spacing[2],
    borderRadius: radius.pill,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderRadius: radius.panel,
    padding: spacing[1],
  },
  choice: {
    flex: 1,
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 0,
    borderColor: 'transparent',
  },
});
