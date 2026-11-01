import { Pressable, StyleSheet, View } from 'react-native';
import type { RoomDiscussionSummary } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Icon, Tag, Text } from '@knowscroll/ui';
import { TAG_WORDS } from './ask-words';

/** "8 replies · last: Null" from the room's own figures for the topic; "No replies yet" when no one has spoken. */
export function topicFigures(topic: Pick<RoomDiscussionSummary, 'replyCount' | 'lastReplyBy'>): string {
  if (topic.replyCount === 0) return 'No replies yet';
  const replies = `${String(topic.replyCount)} ${topic.replyCount === 1 ? 'reply' : 'replies'}`;
  return topic.lastReplyBy === undefined ? replies : `${replies} · last: ${topic.lastReplyBy.name}`;
}

/**
 * The card a topic leaves in the discussion it began from (R3 B1 "The card stays"): its tag, its title and, while the
 * room's own list is at hand, how many replies it has and who spoke last. It opens the topic. The figures are the room's,
 * read with the room, so the card keeps up as the topic does.
 */
export function TopicCard({
  topic,
  figures,
  onOpen,
}: {
  readonly topic: { readonly discussionId: string; readonly title: string; readonly tag?: keyof typeof TAG_WORDS };
  readonly figures: RoomDiscussionSummary | undefined;
  readonly onOpen: (discussionId: string) => void;
}) {
  return (
    <Pressable
      role="link"
      accessibilityLabel={`Topic: ${topic.title}${figures === undefined ? '' : `, ${topicFigures(figures)}`}`}
      onPress={() => onOpen(topic.discussionId)}
      style={styles.card}
      testID={`topic-card-${topic.discussionId}`}
    >
      <View style={styles.tags}>
        <Text variant="monoXs" color={content.ink2}>
          Topic
        </Text>
        {topic.tag === undefined ? null : <Tag label={TAG_WORDS[topic.tag]} />}
        {topic.tag !== 'question' || figures === undefined ? null : (
          <Tag label={figures.waiting === true ? 'Open for people' : 'Answered by a person'} />
        )}
      </View>
      <View style={styles.main}>
        <Text variant="ui" numberOfLines={2} style={styles.title}>
          {topic.title}
        </Text>
        <Icon name="arrowRight" size={16} color={content.ink} />
      </View>
      {figures === undefined ? null : (
        <Text variant="metaS" color={content.ink2}>
          {topicFigures(figures)}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[1],
    maxWidth: '82%',
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  tags: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  main: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  title: { flex: 1 },
});
