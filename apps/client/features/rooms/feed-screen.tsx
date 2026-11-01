import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  emptyFeedWords,
  feedSorts,
  feedWindows,
  sortWords,
  type AccountScope,
  type RoomFeedController,
  type RoomFeedState,
} from '@knowscroll/client-core';
import type { FeedbackTarget } from '@knowscroll/client-core';
import type { RoomIdentity, RoomInhabitant } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { FeedbackSheet } from '../feedback/feedback-sheet';
import { ThreadHeader } from '../threads/thread-chrome';
import { AiLabel } from './ai-label';
import { FeedPost } from './feed-post';
import { ResidentMark } from './identity/room-emblem';
import { PostSheet } from './post-sheet';
import { ResidentSheet } from './resident-sheet';
import { ScoutSheet } from './scout-sheet';
import { discussionHref, isRoomId, roomHref } from './room-links';
import { useRoomFeed } from './use-room';

/** The residents who post, as a row of chips: tapping one opens its profile. Names and labels, never a count. */
function Residents({
  residents,
  identity,
  onOpen,
}: {
  readonly residents: readonly RoomInhabitant[];
  readonly identity: RoomIdentity | undefined;
  readonly onOpen: (resident: RoomInhabitant) => void;
}) {
  return (
    <View style={styles.residents} role="group" accessibilityLabel="Residents of this room" testID="feed-residents">
      {residents.map((resident) => (
        <Pressable
          key={resident.inhabitant}
          role="button"
          accessibilityLabel={`${resident.name}, ${resident.label.replace(/\s·\s/g, ', ')}. Open profile`}
          onPress={() => onOpen(resident)}
          style={styles.resident}
          testID={`feed-resident-${resident.inhabitant}`}
        >
          {identity === undefined ? null : <ResidentMark kit={identity.kit} resident={resident.inhabitant} />}
          <Text variant="ui">{resident.name}</Text>
          <AiLabel label={resident.label} />
        </Pressable>
      ))}
    </View>
  );
}

/**
 * The sorts and the window (T3 "Hot · New · Top"): three tabs, and under Top the window it counts. Rising is not offered. The tabs
 * say in words what each shows, and say that votes come from people only, so the order is never read as a machine's choice.
 */
function SortBar({
  state,
  controller,
  canPost,
  onPost,
}: {
  readonly state: RoomFeedState;
  readonly controller: RoomFeedController;
  readonly canPost: boolean;
  readonly onPost: () => void;
}) {
  return (
    <View style={styles.sortBar}>
      <View style={styles.sortRow}>
        <View role="group" accessibilityLabel="Order of the feed" style={styles.tabs}>
          {feedSorts.map(({ sort, label }) => (
            <Button
              key={sort}
              label={label}
              size="sm"
              variant={state.sort === sort ? 'ink' : 'default'}
              toggled={state.sort === sort}
              onPress={() => void controller.setSort(sort)}
              testID={`feed-sort-${sort}`}
            />
          ))}
        </View>
        {canPost ? (
          <Button label="Post" icon="plus" size="sm" variant="primary" onPress={onPost} testID="feed-post-open" />
        ) : null}
      </View>
      {state.sort === 'top' ? (
        <View role="group" accessibilityLabel="Which posts Top counts" style={styles.tabs}>
          {feedWindows.map(({ window, label }) => (
            <Button
              key={window}
              label={label}
              size="sm"
              variant={state.window === window ? 'ink' : 'ghost'}
              toggled={state.window === window}
              onPress={() => void controller.setWindow(window)}
              testID={`feed-window-${window}`}
            />
          ))}
        </View>
      ) : null}
      <Text variant="monoXs" color={content.ink2} testID="feed-people-only">
        VOTES COME FROM PEOPLE ONLY · AGENTS CAN’T VOTE
      </Text>
      <Text variant="metaS" color={content.ink2}>
        {sortWords[state.sort]}
      </Text>
    </View>
  );
}

function Body({
  scope,
  roomId,
  state,
  controller,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly state: RoomFeedState;
  readonly controller: RoomFeedController;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<RoomInhabitant>();
  const [scoutOpen, setScoutOpen] = useState(false);
  const [postOpen, setPostOpen] = useState(false);
  const [reporting, setReporting] = useState<FeedbackTarget>();
  const view = state.view;
  if (view === undefined) return null;
  const { identity } = view;
  const now = new Date();
  const empty = emptyFeedWords(view.aiLevel);
  return (
    <>
      {state.offline ? <Banner kind="offline" lead="Offline." message="This may be out of date." /> : null}
      <Residents residents={view.residents} identity={identity} onOpen={setOpen} />
      {view.scout === undefined ? null : (
        <Button
          label={view.scout.state === 'on' ? 'Your scout' : 'Send your scout'}
          variant="default"
          size="sm"
          onPress={() => setScoutOpen(true)}
          accessibilityHint="Choose which of this room’s topics your own agent looks in"
          testID="feed-scout-open"
        />
      )}
      <SortBar state={state} controller={controller} canPost={view.canPost} onPost={() => setPostOpen(true)} />
      {view.posts.length === 0 ? (
        <View style={styles.empty} accessibilityLiveRegion="polite" testID="feed-empty">
          <Text variant="title" heading={2}>
            {empty.title}
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            {empty.body}
          </Text>
        </View>
      ) : (
        <View role="list" accessibilityLabel="Posts in the feed" style={styles.list} testID="feed-list">
          {view.posts.map((post) => (
            <View key={post.discussionId} role="listitem">
              <FeedPost
                post={post}
                identity={identity}
                now={now}
                href={discussionHref(roomId, post.discussionId)}
                onOpen={() => router.push(discussionHref(roomId, post.discussionId))}
                onVote={(voted) => void controller.vote(post.discussionId, voted)}
                onStopScout={view.canEditMemory ? (personId) => void controller.stopScout(personId, true) : undefined}
              />
            </View>
          ))}
        </View>
      )}
      <PostSheet
        scope={scope}
        visible={postOpen}
        working={state.working}
        postsPerDay={view.limits.memberPostsPerDay}
        onPost={(draft) => controller.post(draft)}
        onOpenExisting={(discussionId) => router.push(discussionHref(roomId, discussionId))}
        onClose={() => setPostOpen(false)}
      />
      {scoutOpen && view.scout !== undefined ? (
        <ScoutSheet
          scout={view.scout}
          working={state.working}
          refused={state.refused}
          visible
          now={now}
          onSave={(draft) => controller.setScout(draft)}
          onClose={() => setScoutOpen(false)}
        />
      ) : null}
      <ResidentSheet
        resident={open}
        feed={view}
        identity={identity}
        working={state.working}
        refused={state.refused}
        visible={open !== undefined}
        onClose={() => setOpen(undefined)}
        onReplace={(text) => controller.replaceMemory(text)}
        onMute={(muted) => void controller.setMuted(muted)}
        onReport={(messageId) => {
          setOpen(undefined);
          setReporting({ kind: 'room_message', messageId });
        }}
        onIntroduce={(inhabitant) => void controller.introduce(inhabitant)}
        onOpenPost={(discussionId) => {
          setOpen(undefined);
          router.push(discussionHref(roomId, discussionId));
        }}
      />
      <FeedbackSheet target={reporting} onClose={() => setReporting(undefined)} />
    </>
  );
}

/**
 * The room's Feed (T3 "Rooms with residents"): what members and residents posted, in the order the reader picks (Hot, New or Top).
 * A member's post links a Reel, a Scroll or a source; a resident's or scout's find is a real library asset with a short labelled note.
 * Only people vote, and a vote is a count and never a name; there is no karma and no leaderboard, and no resident can be messaged. A
 * reader whose AI is Off is listed no find but still every post a member made; a room with nothing new is told that, and nothing is
 * made up to fill it.
 */
function FeedRoom({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const router = useRouter();
  const { controller, state } = useRoomFeed(scope, roomId);
  const back = () => (router.canGoBack() ? router.back() : router.replace(roomHref(roomId)));
  useDocumentTitle('Feed');
  const view = state.view;
  if (state.phase === 'loading') return <Skeleton rows={4} label="Loading the feed" />;
  if (view === undefined)
    return state.phase === 'failed' ? (
      <StateBlock
        title="Can’t open the feed"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    ) : (
      <StateBlock
        title="The feed isn’t available"
        body="You may no longer be in this room, or it may have closed."
        actions={[{ label: 'Back to the room', role: 'link', href: roomHref(roomId), onPress: back }]}
      />
    );
  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="feed-screen">
      <ThreadHeader
        title="Feed"
        people={
          view.scout === undefined
            ? 'Posts from this room’s people and residents'
            : 'Posts from this room’s people, residents and scouts'
        }
        onBack={back}
        onMenu={undefined}
      />
      <View style={styles.column}>
        <Body scope={scope} roomId={roomId} state={state} controller={controller} />
      </View>
    </ScrollView>
  );
}

/** `/rooms/<id>/feed`: signed in, a member's feed; anything else is the same refusal as a room that is not there. */
export function RoomFeedScreen({ roomId }: { readonly roomId: string }) {
  const { state } = useAccountScope();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {!isRoomId(roomId) || state.status !== 'signed_in' ? (
        <StateBlock title="The feed isn’t available" body="Sign in and open the room again." />
      ) : (
        <FeedRoom key={roomId} scope={state.scope} roomId={roomId} />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  scroll: { flexGrow: 1, paddingBottom: spacing[8] },
  column: {
    gap: spacing[4],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  residents: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  resident: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  list: { gap: spacing[3] },
  sortBar: { gap: spacing[2] },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  empty: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: 'dashed',
    borderRadius: radius.card,
  },
});
