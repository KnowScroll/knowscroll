import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import {
  agoWords,
  feedAuthorName,
  findKindWord,
  findTitleWords,
  postCard,
  postKindWord,
  postTitleWords,
  scoutSignature,
} from '@knowscroll/client-core';
import type { RoomFeedPost, RoomIdentity, RoomSource } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';
import { ContentCard } from '../conversations/message-views';
import { PersonAvatar } from '../conversations/person-avatar';
import { AiLabel } from './ai-label';
import { FeedVote } from './feed-vote';
import { ResidentMark } from './identity/room-emblem';
import { ScoutMark } from './scout-mark';

type Find = Extract<RoomFeedPost, { kind: 'find' }>;
type MemberPost = Extract<RoomFeedPost, { kind: 'post' }>;

/**
 * A source as a plain link (D-272): the site's name and the address, as text. It is never previewed, fetched or opened inside the
 * app: on the web it is a real link that opens in a new tab with no opener and no referrer, so the address is what a member sees
 * before they go, and anyone can copy it.
 */
function SourceLink({ source }: { readonly source: RoomSource }) {
  const web =
    Platform.OS === 'web'
      ? ({
          href: source.url,
          hrefAttrs: { target: '_blank', rel: 'noopener noreferrer nofollow ugc' },
        } as object)
      : {};
  return (
    <Pressable
      role="link"
      accessibilityLabel={`Source: ${source.host}. Opens ${source.url} in a new tab`}
      onPress={() => {
        if (Platform.OS !== 'web') void Linking.openURL(source.url);
      }}
      {...web}
      style={styles.source}
      testID="feed-post-source"
    >
      <Icon name="link" size={18} color={content.ink} />
      <View style={styles.sourceText}>
        <Text variant="ui">{source.host}</Text>
        <Text variant="metaS" color={content.ink2} numberOfLines={1}>
          {source.url}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * The foot of every post: the vote and the talk under it. A held-back note is the first message of the talk, so the way to it
 * is named for what the reader came for.
 */
function PostFoot({
  post,
  href,
  onOpen,
  onVote,
  title,
  noteHeldBack = false,
}: {
  readonly post: RoomFeedPost;
  readonly href: string;
  readonly onOpen: () => void;
  readonly onVote: (voted: boolean) => void;
  readonly title: string;
  readonly noteHeldBack?: boolean;
}) {
  const replies = noteHeldBack
    ? 'Read the note'
    : post.replies === 0
      ? 'Start the talk'
      : `${String(post.replies)} ${post.replies === 1 ? 'reply' : 'replies'}`;
  return (
    <View style={styles.foot}>
      <FeedVote post={post} onVote={onVote} />
      <Button
        label={replies}
        size="sm"
        variant="ghost"
        role="link"
        href={href}
        onPress={onOpen}
        accessibilityHint={`Opens the talk about ${title}`}
        testID="feed-post-discuss"
      />
    </View>
  );
}

function FindPost({
  post,
  identity,
  now,
  href,
  onOpen,
  onVote,
  onStopScout,
}: {
  readonly post: Find;
  readonly identity: RoomIdentity | undefined;
  readonly now: Date;
  readonly href: string;
  readonly onOpen: () => void;
  readonly onVote: (voted: boolean) => void;
  readonly onStopScout?: ((personId: string) => void) | undefined;
}) {
  const { author } = post;
  const name = feedAuthorName(author);
  const signature = scoutSignature(author);
  const age = agoWords(now.getTime() - new Date(post.postedAt).getTime());
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
      <PostFoot
        post={post}
        href={href}
        onOpen={onOpen}
        onVote={onVote}
        title={findTitleWords(post)}
        noteHeldBack={post.note === undefined}
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

function PersonPost({
  post,
  now,
  href,
  onOpen,
  onVote,
}: {
  readonly post: MemberPost;
  readonly now: Date;
  readonly href: string;
  readonly onOpen: () => void;
  readonly onVote: (voted: boolean) => void;
}) {
  const name = feedAuthorName(post.author);
  const age = agoWords(now.getTime() - new Date(post.postedAt).getTime());
  const card = postCard(post);
  return (
    <View
      style={styles.post}
      role="article"
      accessibilityLabel={`${name} posted a ${postKindWord(post)}: ${postTitleWords(post)}`}
      testID={`feed-post-${post.discussionId}`}
    >
      <View style={styles.head} testID="feed-post-head">
        <PersonAvatar person={post.author.person} size={28} />
        <Text variant="ui">{name}</Text>
        <Text variant="metaS" color={content.ink2} style={styles.age}>
          {age}
        </Text>
      </View>
      <Text variant="title" heading={3} testID="feed-post-title">
        {post.title}
      </Text>
      <Text variant="body" testID="feed-post-note">
        {post.words}
      </Text>
      {post.link.kind === 'source' ? (
        <SourceLink source={post.link.source} />
      ) : card === undefined ? null : (
        <ContentCard card={card} />
      )}
      <PostFoot post={post} href={href} onOpen={onOpen} onVote={onVote} title={post.title} />
    </View>
  );
}

/**
 * One post in the room's Feed (T3 "A resident's post", "A scout's find", "People and residents mixed"): a resident's or scout's find, or
 * a member's own post. A find shows who posted it, labelled AI, its short note, the library asset it is about and the way into the
 * discussion; a scout's find is signed "Sent by <owner>" so it is never read as the owner's own words. A member's post shows their
 * headline and words and one link, a library asset or a plain source link. The mark of an AI is drawn for the eye only; the AI label
 * says what the author is, and a screen reader reads the name, then "AI, Explainer" or "AI, Scout", then who sent it, then the words.
 * Every post carries a vote and a count of people (D-273): a resident or a scout cannot vote, and a member cannot vote on their own.
 */
export function FeedPost({
  post,
  identity,
  now,
  href,
  onOpen,
  onVote,
  onStopScout,
}: {
  readonly post: RoomFeedPost;
  readonly identity: RoomIdentity | undefined;
  readonly now: Date;
  /** The post's discussion, as an address a link can show. */
  readonly href: string;
  readonly onOpen: () => void;
  readonly onVote: (voted: boolean) => void;
  /** A moderator's way to stop the scout that sent a find; absent for everyone else (D-261). */
  readonly onStopScout?: ((personId: string) => void) | undefined;
}) {
  return post.kind === 'find' ? (
    <FindPost
      post={post}
      identity={identity}
      now={now}
      href={href}
      onOpen={onOpen}
      onVote={onVote}
      onStopScout={onStopScout}
    />
  ) : (
    <PersonPost post={post} now={now} href={href} onOpen={onOpen} onVote={onVote} />
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
  foot: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  signature: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    backgroundColor: content.highlight,
  },
  source: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper2,
  },
  sourceText: { flex: 1, gap: spacing[1] },
});
