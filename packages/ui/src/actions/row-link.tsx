import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { content, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { linkPress } from '../display/link';
import { linkSemantics } from '../display/semantics';

export interface RowLinkProps {
  /** The row's whole accessible name ("Ravi, unread, Shared a Reel · …"); it is one link. */
  readonly label: string;
  readonly onPress: () => void;
  /** The address. On the web the row becomes a real `<a href>` (Enter, middle-click, new tab). */
  readonly href?: string;
  readonly children: ReactNode;
  readonly testID?: string;
}

/**
 * A list row that is one link to a destination (Talk's conversations). It is at least 48 px
 * tall, carries the focus ring on paper, and leaves its content to the caller.
 */
export function RowLink({ label, onPress, href, children, testID }: RowLinkProps) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...linkSemantics(href !== undefined)}
      {...linkPress({ href, onNavigate: onPress })}
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, focus.style]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: target.comfortable, paddingVertical: spacing[3] },
  pressed: { backgroundColor: content.highlight },
});
