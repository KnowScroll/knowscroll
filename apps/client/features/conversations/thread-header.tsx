import { StyleSheet, View } from 'react-native';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text } from '@knowscroll/ui';
import { PersonAvatar } from './person-avatar';

export interface ThreadHeaderProps {
  readonly peer: PublicPersonRef | undefined;
  readonly fallbackName: string;
  readonly onBack: () => void;
  /** Opens the conversation's options; absent while there is no conversation to act on. */
  readonly onMenu: (() => void) | undefined;
  /** Turns a card shared here into a thread; absent when no card can be one. */
  readonly onStartThread?: (() => void) | undefined;
}

/** C02's top bar: Back, the other person, Start a thread when a card can become one, and the options menu. */
export function ThreadHeader({ peer, fallbackName, onBack, onMenu, onStartThread }: ThreadHeaderProps) {
  return (
    <View style={styles.header}>
      <IconButton icon="back" label="Back to Talk" variant="plain" onPress={onBack} />
      {peer === undefined ? null : <PersonAvatar person={peer} size={40} />}
      <View style={styles.title}>
        <Text variant="ui" heading={1} numberOfLines={1}>
          {peer?.displayName ?? fallbackName}
        </Text>
      </View>
      {onStartThread === undefined ? null : (
        <Button label="Start a thread" size="sm" icon="talk" onPress={onStartThread} testID="start-a-thread" />
      )}
      {onMenu === undefined ? null : (
        <IconButton icon="more" label="Conversation options" variant="plain" onPress={onMenu} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    borderBottomWidth: borderWidth.regular,
    borderBottomColor: content.ink,
  },
  title: { flex: 1 },
});
