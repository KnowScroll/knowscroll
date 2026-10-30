import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, layer, radius, spacing } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { dialogHostSemantics, dialogSemantics } from '../display/semantics';
import { Icon } from '../icons/icon';
import type { IconName } from '../icons/icon-paths';
import { useOverlayHistory } from '../overlay/overlay-history';
import { usePageInert } from '../overlay/page-inert';
import { Text } from '../text/text';
import { useTalkTheme } from './talk-theme';

export interface TalkMenuProps {
  readonly visible: boolean;
  /** The menu's accessible name ("Message options"). */
  readonly title: string;
  /** Esc, Back, a tap on the dimmed chat and the system back gesture all call this. */
  readonly onClose: () => void;
  /** Which side the echoed message sits on, so it stays where the bubble was. */
  readonly echoAlign: 'start' | 'end';
  /** The message the menu is about, drawn above it while the rest of the chat dims (T3 kit). */
  readonly echo: ReactNode;
  readonly children: ReactNode;
}

/**
 * The long-press menu (T3 kit): the chat dims, the message stays visible, and the reaction bar and the
 * actions float over it. It is an overlay and not a route, like the sheets: Esc, Back and a tap on the
 * dimmed chat close only the menu, on the web through one transient history entry.
 */
export function TalkMenu({ visible, title, onClose, echoAlign, echo, children }: TalkMenuProps) {
  const theme = useTalkTheme();
  useOverlayHistory(visible, onClose);
  usePageInert(visible);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      {...dialogHostSemantics(title)}
    >
      <View style={styles.host}>
        <Pressable
          onPress={onClose}
          accessible={false}
          importantForAccessibility="no"
          focusable={false}
          testID="talk-menu-scrim"
          style={[styles.scrim, { backgroundColor: theme.dim }]}
        />
        <View {...dialogSemantics(title)} testID="talk-menu" style={styles.column}>
          <View style={[styles.echo, echoAlign === 'end' ? styles.end : styles.start]}>{echo}</View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

/** The actions card of the menu. */
export function MenuList({ children }: { readonly children: ReactNode }) {
  const theme = useTalkTheme();
  return (
    <View style={[styles.list, { backgroundColor: theme.menu.fill }]} role="menu" accessibilityLabel="Message actions">
      {children}
    </View>
  );
}

export interface MenuRowProps {
  readonly icon: IconName;
  readonly label: string;
  /** The key that does the same on a keyboard, shown at the end of the row ("R"). */
  readonly keyHint?: string;
  readonly danger?: boolean;
  readonly onPress: () => void;
  readonly testID?: string;
}

/** One action of the menu: a 48 px row with its icon and, on a keyboard, its key. */
export function MenuRow({ icon, label, keyHint, danger = false, onPress, testID }: MenuRowProps) {
  const theme = useTalkTheme();
  const focus = useFocusRing('onLight');
  const color = danger ? theme.menu.danger : theme.menu.text;
  return (
    <Pressable
      {...focus.props}
      role="menuitem"
      accessibilityLabel={label}
      accessibilityHint={keyHint === undefined ? undefined : `Key ${keyHint}`}
      onPress={onPress}
      testID={testID}
      style={[styles.row, { borderTopColor: theme.menu.rule }, focus.style]}
    >
      <Icon name={icon} size={20} color={color} />
      <View style={styles.rowLabel}>
        <Text variant="ui" color={color}>
          {label}
        </Text>
      </View>
      {keyHint === undefined ? null : (
        <Text variant="monoXs" color={color}>
          {keyHint}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing[5] },
  column: { width: '100%', maxWidth: 336, gap: spacing['2.5'], zIndex: layer.sheet },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: layer.scrim },
  echo: { maxWidth: '100%' },
  start: { alignSelf: 'flex-start' },
  end: { alignSelf: 'flex-end' },
  list: { borderRadius: radius.panel, overflow: 'hidden' },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    borderTopWidth: borderWidth.hairline,
  },
  rowLabel: { flex: 1 },
});
