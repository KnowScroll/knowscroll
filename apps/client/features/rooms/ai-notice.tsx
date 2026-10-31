import { StyleSheet, View } from 'react-native';
import type { RoomWelcome } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

/**
 * What a member is told about AI in a room. True of what the room does today: residents are always labelled, answer when
 * someone asks, may join in on their own, and one writes a short recap when a member returns after a long absence, reading
 * only this room's recent messages without names.
 */
export const AI_NOTICE = {
  title: 'AI lives in this room',
  body: 'AI residents are always labelled AI and never pretend to be people. They answer when someone asks, and now and then join in when a question goes unanswered. To do that they read this room’s recent messages, without names. When you come back after a long time away, Halley may write a short recap of what you missed, once for everyone who returns in the same stretch.',
  control: 'You can change what AI reads at any time: room menu, AI here.',
} as const;

/**
 * The notice a member sees once, when they first open the room after joining, with the welcome a resident gives
 * (a template of the room's own words: no model is asked). Acknowledging it records that they have read it; after that
 * the same words live only in the room menu under "AI here".
 */
export function AiNoticeCard({
  busy,
  welcome,
  onAcknowledge,
}: {
  readonly busy: boolean;
  readonly welcome?: RoomWelcome | undefined;
  readonly onAcknowledge: () => void;
}) {
  return (
    <View style={styles.card} testID="ai-notice" role="region" accessibilityLabel="About AI in this room">
      {welcome === undefined ? null : (
        <View style={styles.welcome} testID="room-welcome">
          <View style={styles.who}>
            <Text variant="ui">{welcome.resident.name}</Text>
            <AiLabel label={welcome.resident.label} />
          </View>
          <Text variant="bodyS">{welcome.text}</Text>
        </View>
      )}
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
  welcome: { gap: spacing[1] },
  who: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
});
