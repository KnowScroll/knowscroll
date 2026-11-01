import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { toggleSemantics } from '../../display/semantics';
import { useFocusRing } from '../../display/focus-ring';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';

/**
 * Whether a block shows its words instead of its picture or controls: the reader's "Text version"
 * (the T key) sets it for every block, and a block's own switch overrides it for that block alone.
 * Every play block has a text version (D-207): the same content as sentences, derived from the data.
 */
export function useTextVersion(readerWide: boolean): { readonly asText: boolean; readonly toggle: () => void } {
  const [own, setOwn] = useState<boolean | undefined>(undefined);
  const asText = own ?? readerWide;
  return { asText, toggle: () => setOwn(!asText) };
}

function TextSwitch({
  on,
  onPress,
  label,
}: {
  readonly on: boolean;
  readonly onPress: () => void;
  readonly label: string;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...toggleSemantics(on)}
      accessibilityLabel={`Text version of the ${label}`}
      onPress={onPress}
      style={[styles.switch, on ? styles.switchOn : null, focus.style]}
    >
      <Text variant="monoXs" color={on ? content.paper : content.ink}>
        Text
      </Text>
    </Pressable>
  );
}

/**
 * The frame every play block sits in: its name, the switch to its text version and its body. The body is
 * whatever the block draws; a block hands a second body for the text version, so a screen reader and a
 * reader who prefers words get the same content.
 */
export function BlockFrame({
  name,
  label,
  asText,
  onToggleText,
  children,
  testID,
}: {
  /** What the block is called to the reader: "Sort it", "To scale". */
  readonly name: string;
  /** What the block is, for the text switch's accessible name: "sort". */
  readonly label: string;
  readonly asText: boolean;
  readonly onToggleText: () => void;
  readonly children: ReactNode;
  readonly testID: string;
}) {
  return (
    <View style={styles.frame} testID={testID} accessibilityLabel={name} role="group">
      <View style={styles.header}>
        <Tag label={name} variant="neutral" />
        <TextSwitch on={asText} onPress={onToggleText} label={label} />
      </View>
      {children}
    </View>
  );
}

export const frameStyles = StyleSheet.create({
  /** Cards inside a block: the V3 look of an option. */
  card: {
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  note: {
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
    gap: spacing[2],
  },
});

const styles = StyleSheet.create({
  frame: { alignSelf: 'stretch', maxWidth: 480, gap: spacing[3] },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  switch: {
    minHeight: 32,
    minWidth: 44,
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  switchOn: { backgroundColor: content.ink },
});
