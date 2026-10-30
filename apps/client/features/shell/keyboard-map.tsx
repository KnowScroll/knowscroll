import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Text } from '@knowscroll/ui';

interface Shortcut {
  /** The keys as drawn, one chip each; keys pressed together are joined with "+". */
  readonly keys: readonly string[];
  /** The same keys in words, which is what a screen reader hears. */
  readonly spoken: string;
  readonly action: string;
}

interface ShortcutGroup {
  readonly title: string;
  /** Where the keys work: a key listens only while its own part has focus, never on the whole page. */
  readonly where: string;
  readonly shortcuts: readonly Shortcut[];
}

/**
 * Every key the app listens to, by where it works. Keys act only while the part they belong to has
 * focus (the Reel stage, the map, an episode list, the message box), so no single-character key
 * fires from anywhere else on the page (WCAG 2.1.4). Add a row here in the same change that adds a key.
 */
export const KEYBOARD_MAP: readonly ShortcutGroup[] = [
  {
    title: 'Everywhere',
    where: 'Any screen',
    shortcuts: [
      { keys: ['Tab'], spoken: 'Tab', action: 'Move to the next control; Shift+Tab goes back' },
      { keys: ['Enter'], spoken: 'Enter', action: 'Open a link or press a button' },
      { keys: ['Space'], spoken: 'Space', action: 'Press the focused button' },
      { keys: ['Esc'], spoken: 'Escape', action: 'Close a sheet, a dialog or an open card' },
    ],
  },
  {
    title: 'Explore',
    where: 'While the video is focused (Tab to it, or click it)',
    shortcuts: [
      { keys: ['↑', '↓'], spoken: 'Up and down arrow', action: 'Previous and next subject' },
      {
        keys: ['←', '→'],
        spoken: 'Left and right arrow',
        action: 'Along the thread: the part before, and the next part or another angle when there is none',
      },
      { keys: ['Space'], spoken: 'Space', action: 'Play or pause' },
    ],
  },
  {
    title: 'Scroll reader',
    where: 'While the Scroll is focused (Tab to it, or click it)',
    shortcuts: [
      { keys: ['↓', 'Space'], spoken: 'Down arrow or Space', action: 'Next stop' },
      { keys: ['↑'], spoken: 'Up arrow', action: 'Previous stop' },
      {
        keys: ['→'],
        spoken: 'Right arrow',
        action: 'Continue: the next Part, or another angle when there is no next Part',
      },
      { keys: ['←'], spoken: 'Left arrow', action: 'Back to the Part before' },
      { keys: ['N'], spoken: 'N', action: 'A new topic in the same format' },
      { keys: ['U'], spoken: 'U', action: 'Your Universe' },
      { keys: ['A'], spoken: 'A', action: 'Ask about this (in Explore)' },
      { keys: ['T'], spoken: 'T', action: 'Text version of the picture' },
      { keys: ['F'], spoken: 'F', action: 'Switch between Reel and Scroll' },
      { keys: ['1', '2', '3', '4'], spoken: 'Number keys one to four', action: 'Pick an option in a call' },
      { keys: ['Enter'], spoken: 'Enter', action: 'Lock in the pick in a call' },
    ],
  },
  {
    title: 'Reel and Scroll switch',
    where: 'While the switch is focused',
    shortcuts: [{ keys: ['←', '→'], spoken: 'Left and right arrow', action: 'Choose Reel or Scroll' }],
  },
  {
    title: 'Universe',
    where: 'While the map is focused',
    shortcuts: [
      { keys: ['←', '↑', '→', '↓'], spoken: 'Arrow keys', action: 'Pan' },
      { keys: ['+', '−'], spoken: 'Plus and minus', action: 'Zoom in and out' },
      { keys: ['Home'], spoken: 'Home', action: 'Fit the whole map' },
      { keys: ['/'], spoken: 'Slash', action: 'Search places' },
    ],
  },
  {
    title: 'Talk',
    where: 'While the message box or the episode list is focused (the Series sheet on a phone, the panel on a desktop)',
    shortcuts: [
      { keys: ['Enter'], spoken: 'Enter', action: 'Send the message' },
      { keys: ['Shift', 'Enter'], spoken: 'Shift and Enter', action: 'New line' },
      {
        keys: ['↑', '↓', '←', '→'],
        spoken: 'Up, down, left and right arrow',
        action: 'Previous and next episode, in the episode list; the Series sheet stays open',
      },
    ],
  },
  {
    title: 'Talk messages',
    where: 'While a message’s options button is focused (Tab to it; it shows on hover or focus)',
    shortcuts: [
      { keys: ['R'], spoken: 'R', action: 'Reply to the message; the reply waits above the message box' },
      { keys: ['E'], spoken: 'E', action: 'Open the message menu: the five reactions, Copy and Report' },
      { keys: ['Esc'], spoken: 'Escape', action: 'In the message box, cancel the reply; in the menu, close it' },
    ],
  },
];

function Keys({ shortcut }: { readonly shortcut: Shortcut }) {
  return (
    <View aria-hidden style={styles.keys}>
      {shortcut.keys.map((key) => (
        <View key={key} style={styles.key}>
          <Text variant="metaS">{key}</Text>
        </View>
      ))}
    </View>
  );
}

/** The keyboard map as a sheet: reachable from Account and from the desktop Explore footer. */
export function KeyboardMapSheet({ visible, onClose }: { readonly visible: boolean; readonly onClose: () => void }) {
  return (
    <BottomSheet visible={visible} title="Keyboard shortcuts" onClose={onClose}>
      <View style={styles.groups}>
        {KEYBOARD_MAP.map((group) => (
          <View key={group.title} role="group" aria-label={group.title} style={styles.group}>
            <Text variant="ui" heading={3}>
              {group.title}
            </Text>
            <Text variant="meta" color={content.ink2}>
              {group.where}
            </Text>
            <View role="list" style={styles.list}>
              {group.shortcuts.map((shortcut) => (
                <View
                  key={shortcut.spoken}
                  role="listitem"
                  accessible
                  accessibilityLabel={`${shortcut.spoken}: ${shortcut.action}`}
                  style={styles.row}
                >
                  <Keys shortcut={shortcut} />
                  <View aria-hidden style={styles.action}>
                    <Text variant="bodyS">{shortcut.action}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  groups: { gap: spacing[5], paddingBottom: spacing[4] },
  group: { gap: spacing[1] },
  list: { gap: spacing[2], paddingTop: spacing[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], flexWrap: 'wrap' },
  keys: { flexDirection: 'row', gap: spacing[1], minWidth: 96 },
  key: {
    minWidth: 28,
    height: 28,
    paddingHorizontal: spacing['1.5'],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.tag,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  action: { flex: 1, minWidth: 160 },
});
