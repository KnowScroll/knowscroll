import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  emptyFeedWords,
  type AccountScope,
  type RoomFeedController,
  type RoomFeedState,
} from '@knowscroll/client-core';
import type { RoomIdentity, RoomInhabitant } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { ThreadHeader } from '../threads/thread-chrome';
import { AiLabel } from './ai-label';
import { FeedPost } from './feed-post';
import { ResidentMark } from './identity/room-emblem';
import { ResidentSheet } from './resident-sheet';
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

function Body({
  roomId,
  state,
  controller,
}: {
  readonly roomId: string;
  readonly state: RoomFeedState;
  readonly controller: RoomFeedController;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<RoomInhabitant>();
  const view = state.view;
  if (view === undefined) return null;
  const { identity } = view;
  const now = new Date();
  const empty = emptyFeedWords(view.aiLevel);
  return (
    <>
      {state.offline ? <Banner kind="offline" lead="Offline." message="This may be out of date." /> : null}
      <Residents residents={view.residents} identity={identity} onOpen={setOpen} />
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
        <View role="list" accessibilityLabel="Finds from the library" style={styles.list} testID="feed-list">
          {view.posts.map((post) => (
            <View key={post.discussionId} role="listitem">
              <FeedPost
                post={post}
                identity={identity}
                now={now}
                href={discussionHref(roomId, post.discussionId)}
                onOpen={() => router.push(discussionHref(roomId, post.discussionId))}
              />
            </View>
          ))}
        </View>
      )}
      <ResidentSheet
        resident={open}
        feed={view}
        identity={identity}
        working={state.working}
        refused={state.refused}
        visible={open !== undefined}
        onClose={() => setOpen(undefined)}
        onReplace={(text) => controller.replaceMemory(text)}
      />
    </>
  );
}

/**
 * The room's Feed (T3 "Rooms with residents"): what residents found in the library for this room, newest first, each one a real
 * Reel or Scroll with a short labelled note, and what the residents remember about the room. It is a place to read and to start
 * the talk, not a place to rank: there are no votes on it, no counts of people, and no resident can be messaged. A reader whose AI is
 * Off is told so and listed nothing; a room whose library has nothing new for it is told that, and nothing is made up to fill it.
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
        people="Finds from the library, by this room’s residents"
        onBack={back}
        onMenu={undefined}
      />
      <View style={styles.column}>
        <Body roomId={roomId} state={state} controller={controller} />
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
  empty: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: 'dashed',
    borderRadius: radius.card,
  },
});
