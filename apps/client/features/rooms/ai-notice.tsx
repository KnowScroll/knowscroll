import { StyleSheet, View } from 'react-native';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';

/**
 * What a member is told about AI in a room. True of what the room does today: residents are always labelled, answer when
 * someone asks, and may join in on their own, reading only this room's recent messages without names.
 */
export const AI_NOTICE = {
  title: 'AI lives in this room',
  body: 'AI residents are always labelled AI and never pretend to be people. They answer when someone asks, and now and then join in when a question goes unanswered. To do that they read this room’s recent messages, without names.',
  control: 'You can change what AI reads at any time: room menu, AI here.',
} as const;

/**
 * The notice a member sees once, when they first open the room after joining. Acknowledging it records that they
 * have read it; after that the same words live only in the room menu under "AI here".
 */
export function AiNoticeCard({ busy, onAcknowledge }: { readonly busy: boolean; readonly onAcknowledge: () => void }) {
  return (
    <View style={styles.card} testID="ai-notice" role="region" accessibilityLabel="About AI in this room">
      <Text variant="ui">{AI_NOTICE.title}</Text>
      <Text variant="meta" color={content.ink2}>
        {AI_NOTICE.body}
      </Text>
      <Text variant="meta" color={content.ink2}>
        {AI_NOTICE.control}
      </Text>
      <Button label="Got it" size="sm" variant="primary" busy={busy} onPress={onAcknowledge} testID="ai-notice-ack" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[2],
    padding: spacing[3],
    marginHorizontal: layout.gutter,
    marginTop: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper2,
    alignItems: 'flex-start',
  },
});
