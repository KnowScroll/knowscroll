import { StyleSheet, View } from 'react-native';
import { agoWords, feedAuthorName, findKindWord, findTitleWords, scoutSignature } from '@knowscroll/client-core';
import type { RoomFeedPost, RoomIdentity } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { ContentCard } from '../conversations/message-views';
import { AiLabel } from './ai-label';
import { ResidentMark } from './identity/room-emblem';
import { ScoutMark } from './scout-mark';

/**
 * One find in the room's feed (T3 "A resident's post", "A scout's find"): who posted it, labelled AI, its short note, the library
 * asset it is about as a card the member opens, and the way into the discussion. A scout's find is signed "Sent by <owner>" in a
 * yellow strip, so it is never read as the owner's own words. The mark is drawn for the eye only; the AI label says what the author
 * is, and a screen reader reads the name, then "AI, Explainer" or "AI, Scout", then who sent it, then the words. A Quieter reader's
 * note is held back (`folded`) and is read in the discussion; an Off reader is never listed a find. There is no vote and no count
 * of people anywhere on it: only people can mark an answer Useful, in the discussion, and a resident or a scout never can.
 */
export function FeedPost({
  post,
  identity,
  now,
  href,
  onOpen,
  onStopScout,
}: {
  readonly post: RoomFeedPost;
  readonly identity: RoomIdentity | undefined;
  readonly now: Date;
  /** The find's discussion, as an address a link can show. */
  readonly href: string;
  readonly onOpen: () => void;
  /** A moderator's way to stop the scout that sent a find; absent for everyone else (D-261). */
  readonly onStopScout?: ((personId: string) => void) | undefined;
}) {
  const { author } = post;
  const name = feedAuthorName(author);
  const signature = scoutSignature(author);
  const age = agoWords(now.getTime() - new Date(post.postedAt).getTime());
  // A held-back note is the first message of the talk, so the way to it is named for what the reader came for.
  const replies =
    post.note === undefined
      ? 'Read the note'
      : post.replies === 0
        ? 'Start the talk'
        : `${String(post.replies)} ${post.replies === 1 ? 'reply' : 'replies'}`;
  const spoken = `${name}, ${author.label.replace(/\s·\s/g, ', ')}, ${signature === undefined ? '' : `${signature}, `}`;
  return (
    <View
      style={styles.post}
      role="article"
      accessibilityLabel={`${spoken}found a ${findKindWord(post)}: ${findTitleWords(post)}`}
      testID={`feed-post-${post.discussionId}`}
    >
      <View style={styles.head} testID="feed-post-head">
        {author.kind === 'agent' ? (
          <ScoutMark testID="feed-post-mark" />
        ) : identity === undefined ? null : (
          <ResidentMark kit={identity.kit} resident={author.inhabitant} testID="feed-post-mark" />
        )}
        <Text variant="ui">{name}</Text>
        <AiLabel label={author.label} />
        <Text variant="metaS" color={content.ink2} style={styles.age}>
          {age}
        </Text>
      </View>
      {signature === undefined ? null : (
        <View style={styles.signature} testID="feed-post-signature">
          <Text variant="metaS">{signature}</Text>
        </View>
      )}
      {post.note === undefined ? (
        <Text variant="bodyS" color={content.ink2} testID="feed-post-folded">
          {`${name} found something. The note is in the talk.`}
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
      {author.kind === 'agent' && onStopScout !== undefined ? (
        <Button
          label="Stop this scout"
          size="sm"
          variant="ghost"
          onPress={() => onStopScout(author.sentBy.personId)}
          accessibilityHint={`Stops ${name} from posting in this room until a moderator lets it`}
          testID="feed-post-stop-scout"
        />
      ) : null}
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
  signature: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: content.highlight,
  },
});
