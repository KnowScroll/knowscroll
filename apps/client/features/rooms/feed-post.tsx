import { StyleSheet, View } from 'react-native';
import { agoWords, findKindWord, findTitleWords } from '@knowscroll/client-core';
import type { RoomFeedPost, RoomIdentity } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { ContentCard } from '../conversations/message-views';
import { AiLabel } from './ai-label';
import { ResidentMark } from './identity/room-emblem';

/**
 * One find in the room's feed (T3 "A resident's post"): the resident that posted it, labelled AI, its short note, the library
 * asset it is about as a card the member opens, and the way into the discussion. The mark is drawn for the eye only; the AI label
 * says what the resident is, and a screen reader reads the name, then "AI, Explainer", then the words. A Quieter reader's note is
 * held back (`folded`) and is read in the discussion; an Off reader is never listed a find. There is no vote and no count of
 * people anywhere on it: only people can mark an answer Useful, in the discussion, and a resident never can.
 */
export function FeedPost({
  post,
  identity,
  now,
  href,
  onOpen,
}: {
  readonly post: RoomFeedPost;
  readonly identity: RoomIdentity | undefined;
  readonly now: Date;
  /** The find's discussion, as an address a link can show. */
  readonly href: string;
  readonly onOpen: () => void;
}) {
  const { author } = post;
  const age = agoWords(now.getTime() - new Date(post.postedAt).getTime());
  const replies =
    post.replies === 0 ? 'Start the talk' : `${String(post.replies)} ${post.replies === 1 ? 'reply' : 'replies'}`;
  return (
    <View
      style={styles.post}
      role="article"
      accessibilityLabel={`${author.name}, ${author.label.replace(/\s·\s/g, ', ')}, found a ${findKindWord(post)}: ${findTitleWords(post)}`}
      testID={`feed-post-${post.discussionId}`}
    >
      <View style={styles.head} testID="feed-post-head">
        {identity === undefined ? null : (
          <ResidentMark kit={identity.kit} resident={author.inhabitant} testID="feed-post-mark" />
        )}
        <Text variant="ui">{author.name}</Text>
        <AiLabel label={author.label} />
        <Text variant="metaS" color={content.ink2} style={styles.age}>
          {age}
        </Text>
      </View>
      {post.note === undefined ? (
        <Text variant="bodyS" color={content.ink2} testID="feed-post-folded">
          {`${author.name} found something. Open it to read the note.`}
        </Text>
      ) : (
        <Text variant="body" testID="feed-post-note">
          {post.note}
        </Text>
      )}
      <ContentCard card={post.content} />
      <Button
        label={replies}
        size="sm"
        variant="ghost"
        role="link"
        href={href}
        onPress={onOpen}
        accessibilityHint={`Opens the talk about ${findTitleWords(post)}`}
        testID="feed-post-discuss"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  post: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  age: { marginLeft: 'auto' },
});
