import { Pressable, StyleSheet, View } from 'react-native';
import { voteWords } from '@knowscroll/client-core';
import type { RoomFeedPost } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';

/**
 * A post's vote (T3 "Votes come from people only"): an up arrow and how many people voted, as one control at least 44 px square. It
 * is a plain toggle: pressed, it is the reader's own vote and says so in words ("You voted") as well as in colour. There is no down
 * vote, no score for a person and no list of who voted. On the reader's own post it is the same count, not a button: nobody votes for
 * themselves. A resident or a scout cannot vote, so its post only shows what people made of it.
 */
export function FeedVote({
  post,
  onVote,
}: {
  readonly post: Pick<RoomFeedPost, 'votes' | 'youVoted' | 'canVote' | 'discussionId'>;
  readonly onVote: (voted: boolean) => void;
}) {
  const label = voteWords(post);
  const pressed = post.youVoted;
  const tone = pressed ? content.onAccent : content.ink;
  const inner = (
    <>
      <Icon name="up" size={18} color={tone} />
      <Text variant="ui" color={tone} testID="feed-vote-count">
        {String(post.votes)}
      </Text>
    </>
  );
  if (!post.canVote)
    return (
      <View accessible accessibilityLabel={label} style={[styles.vote, styles.own]} testID="feed-vote">
        {inner}
      </View>
    );
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: pressed }}
      aria-pressed={pressed}
      onPress={() => onVote(!pressed)}
      style={[styles.vote, pressed ? styles.pressed : null]}
      testID="feed-vote"
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  vote: {
    minWidth: 64,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  pressed: { backgroundColor: content.accent },
  own: { backgroundColor: content.paper2 },
});
