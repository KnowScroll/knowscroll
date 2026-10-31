import type { ReactNode } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { content, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { linkPress } from '../display/link';
import { currentPageSemantics, linkSemantics } from '../display/semantics';

export interface RowLinkProps {
  /** The row's whole accessible name ("Ravi, unread, Shared a Reel · …"); it is one link. */
  readonly label: string;
  readonly onPress: () => void;
  /** The address. On the web the row becomes a real `<a href>` (Enter, middle-click, new tab). */
  readonly href?: string;
  readonly children: ReactNode;
  /** The row whose destination is open beside the list (a two-pane Talk): `aria-current` and a tint. */
  readonly current?: boolean;
  readonly testID?: string;
  /** What shows behind the open or pressed row; the highlight on paper. */
  readonly tint?: string;
}

/**
 * A list row that is one link to a destination (Talk's conversations). It is at least 48 px
 * tall, carries the focus ring on paper, and leaves its content to the caller.
 */
export function RowLink({ label, onPress, href, children, current = false, testID, tint }: RowLinkProps) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...linkSemantics(href !== undefined)}
      {...linkPress({ href, onNavigate: onPress })}
      {...currentPageSemantics(current)}
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.row,
        current || pressed ? styles.pressed : null,
        current || pressed ? tintStyle(tint) : null,
        focus.style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const tintStyle = (tint: string | undefined) => (tint === undefined ? null : { backgroundColor: tint });

const styles = StyleSheet.create({
  row: { minHeight: target.comfortable, paddingVertical: spacing[3] },
  pressed: { backgroundColor: content.highlight },
});
