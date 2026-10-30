import { StyleSheet, View } from 'react-native';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { layout, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text, useTalkTheme } from '@knowscroll/ui';
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

/**
 * C02's top bar in the Talk look (T3 kit): glass over the sky with a paper Back pill, the other person,
 * Start a thread when a card can become one, and the options menu.
 */
export function ThreadHeader({ peer, fallbackName, onBack, onMenu, onStartThread }: ThreadHeaderProps) {
  const theme = useTalkTheme();
  return (
    <View style={[styles.header, { backgroundColor: theme.ground }]}>
      <View style={[styles.glass, { backgroundColor: theme.bar.fill, borderColor: theme.bar.edge }]}>
        <IconButton icon="back" label="Back to Talk" variant="onSpace" size={44} onPress={onBack} />
        {peer === undefined ? null : <PersonAvatar person={peer} size={40} />}
        <View style={styles.title}>
          <Text variant="ui" heading={1} numberOfLines={1} color={theme.bar.text}>
            {peer?.displayName ?? fallbackName}
          </Text>
        </View>
        {onStartThread === undefined ? null : (
          <Button label="Start a thread" variant="space" size="sm" onPress={onStartThread} testID="start-a-thread" />
        )}
        {onMenu === undefined ? null : (
          <IconButton icon="more" label="Conversation options" variant="onSpace" size={44} onPress={onMenu} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing[2], paddingVertical: spacing[2] },
  glass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter - spacing[2],
    paddingVertical: spacing[2],
    borderRadius: 24,
    borderWidth: 1,
  },
  title: { flex: 1 },
});
