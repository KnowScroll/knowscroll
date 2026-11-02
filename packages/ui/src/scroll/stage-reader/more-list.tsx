import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { toggleSemantics } from '../../display/semantics';
import { Text } from '../../text/text';

/** One row of the ••• sheet: what it does, a line on what that means, and the key that does it from the keyboard. */
export interface MoreRow {
  readonly id: string;
  readonly title: string;
  /** One line under the title: what the row does here, or why it cannot. */
  readonly detail: string;
  /** The key as the keyboard map draws it ("S", "⇧S"). */
  readonly keyName: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  /** A row that turns something on or off says which: announced as pressed or not. */
  readonly toggled?: boolean;
}

function MoreRowView({ row }: { readonly row: MoreRow }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      {...(row.toggled === undefined ? {} : toggleSemantics(row.toggled))}
      accessibilityLabel={row.title}
      accessibilityHint={`${row.detail}. Key: ${row.keyName.replace('⇧', 'Shift ')}.`}
      aria-disabled={row.disabled === true}
      disabled={row.disabled === true}
      onPress={row.onPress}
      style={[styles.row, row.disabled === true ? styles.disabled : null, focus.style]}
      testID={`more-${row.id}`}
    >
      <View style={styles.words}>
        <Text variant="ui">{row.title}</Text>
        <Text variant="meta" color={content.ink2} testID={`more-${row.id}-detail`}>
          {row.detail}
        </Text>
      </View>
      <View style={styles.key} aria-hidden>
        <Text variant="monoXs">{row.keyName}</Text>
      </View>
    </Pressable>
  );
}

/**
 * The rows of a Scroll's ••• sheet (V3 G5): one list, a hairline between rows, each with its sub-line and
 * the key that does the same from the keyboard. The rows are the screen's to choose, because what can be done
 * differs by screen (a thread's reader has no Save); this draws them alike.
 */
export function ReaderMoreList({ rows }: { readonly rows: readonly MoreRow[] }) {
  return (
    <View role="list" style={styles.list} testID="more-list">
      {rows.map((row) => (
        <View key={row.id} role="listitem">
          <MoreRowView row={row} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.comfortable + spacing[2],
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
    cursor: 'pointer' as const,
  },
  words: { flex: 1, gap: spacing['0.5'] },
  disabled: { opacity: 0.55, cursor: 'auto' as const },
  key: {
    minWidth: 32,
    minHeight: 28,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.tag,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
});
