import { StyleSheet, View } from 'react-native';
import type { RoomSource } from '@knowscroll/contracts';
import { spacing } from '@knowscroll/design-tokens';
import { SourceLink } from './feed-post';
import { FeedVote } from './feed-vote';

/**
 * What a post of the Feed carries on its own page (T3 "A resident's post", v3 R-8b, D-273): the same vote the Feed shows, as a count of
 * people and the reader's own, and the source it cites as a plain link. The replies are the room's ordinary thread beneath. A
 * discussion that is not a post of the Feed has none of it.
 */
export function PostBar({
  discussionId,
  post,
  source,
  onVote,
}: {
  readonly discussionId: string;
  readonly post: { readonly votes: number; readonly youVoted: boolean; readonly canVote: boolean };
  readonly source: RoomSource | undefined;
  readonly onVote: (voted: boolean) => void;
}) {
  return (
    <View style={styles.bar} testID="post-bar">
      {source === undefined ? null : <SourceLink source={source} />}
      <FeedVote post={{ ...post, discussionId }} onVote={onVote} />
    </View>
  );
}

const styles = StyleSheet.create({ bar: { gap: spacing[3], alignItems: 'flex-start' } });
