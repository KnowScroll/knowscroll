import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createRoom,
  type AccountScope,
  type RoomActivityController,
  type RoomActivityState,
} from '@knowscroll/client-core';
import type { ActivityView } from '@knowscroll/contracts';
import { content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { afterPendingBack } from '../../platform/after-pending-back';
import { newCommandId } from '../../platform/command-id';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { ThreadHeader } from '../threads/thread-chrome';
import { PollCard } from './poll-card';
import { QuizFlow } from './quiz-flow';
import { discussionHref, isRoomId, roomHref } from './room-links';
import { useRoomActivity } from './use-room';

type Ready = Extract<ActivityView, { status: 'ready' }>;

/** A discussion title is at most 80 characters; the quiz's own title may be longer. */
const discussionTitle = (title: string) => (title.length <= 80 ? title : `${title.slice(0, 79).trimEnd()}…`);

function ModeratorTools({
  view,
  state,
  controller,
  onRemoved,
}: {
  readonly view: Ready;
  readonly state: RoomActivityState;
  readonly controller: RoomActivityController;
  readonly onRemoved: () => void;
}) {
  return (
    <View style={styles.moderation} testID="activity-moderation">
      <Text variant="metaS" color={content.freshInk}>
        Moderator tools
      </Text>
      <View style={styles.buttons}>
        {view.activity.kind === 'poll' && view.state === 'open' ? (
          <Button
            label="Close poll"
            size="sm"
            busy={state.working}
            onPress={() => void controller.moderate('close')}
            testID="close-poll"
          />
        ) : null}
        <Button
          label={view.activity.kind === 'poll' ? 'Remove poll' : 'Remove quiz'}
          size="sm"
          variant="ghost"
          busy={state.working}
          onPress={() => void controller.moderate('remove').then((removed) => removed && onRemoved())}
          testID="remove-activity"
        />
      </View>
      <Text variant="meta" color={content.ink2}>
        Closing keeps the votes and shows them to everyone. Removing hides it from the room. Neither changes anyone’s
        universe.
      </Text>
    </View>
  );
}

function ReadyActivity({
  scope,
  roomId,
  view,
  state,
  controller,
  onBack,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly view: Ready;
  readonly state: RoomActivityState;
  readonly controller: RoomActivityController;
  readonly onBack: () => void;
}) {
  const router = useRouter();
  const [roomController] = useState(() => createRoom({ scope, roomId, newId: newCommandId }));
  const kind = view.activity.kind === 'poll' ? 'Poll' : 'Quiz';
  const discuss = (title: string) =>
    void roomController.startDiscussion({ kind: 'topic', title: discussionTitle(title) }).then((created) => {
      if (created !== undefined) afterPendingBack(() => router.push(discussionHref(roomId, created)));
    });
  return (
    <>
      <ThreadHeader
        title={kind}
        people="Optional · only in this room"
        onBack={onBack}
        onPeople={undefined}
        onMenu={undefined}
      />
      <ScrollView contentContainerStyle={styles.body} testID="activity-screen">
        {state.offline ? <Banner kind="offline" lead="Offline." message="This may be out of date." /> : null}
        {view.activity.kind === 'poll' ? (
          <PollCard view={view} poll={view.activity} state={state} controller={controller} onSkip={onBack} />
        ) : (
          <QuizFlow quiz={view.activity} canDiscuss={view.state === 'open'} onDiscuss={discuss} onDone={onBack} />
        )}
        {view.canModerate ? (
          <ModeratorTools view={view} state={state} controller={controller} onRemoved={onBack} />
        ) : null}
        <Text variant="metaS" color={content.ink2}>
          Polls and quizzes are never in a feed and never required. They don’t shape your universe.
        </Text>
      </ScrollView>
    </>
  );
}

function OpenActivity({
  scope,
  roomId,
  activityId,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly activityId: string;
}) {
  const router = useRouter();
  const { controller, state } = useRoomActivity(scope, roomId, activityId);
  const back = () => (router.canGoBack() ? router.back() : router.replace(roomHref(roomId)));
  useDocumentTitle(state.view === undefined ? 'Room activity' : state.view.activity.kind === 'poll' ? 'Poll' : 'Quiz');
  if (state.phase === 'loading')
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading" />
      </View>
    );
  if (state.phase === 'failed')
    return (
      <StateBlock
        title="Can’t open this"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    );
  if (state.view === undefined)
    return (
      <StateBlock
        title="This isn’t available"
        body="It may have been removed, or you may no longer be in this room."
        actions={[{ label: 'Back to the room', role: 'link', href: roomHref(roomId), onPress: back }]}
      />
    );
  return (
    <ReadyActivity
      scope={scope}
      roomId={roomId}
      view={state.view}
      state={state}
      controller={controller}
      onBack={back}
    />
  );
}

/**
 * R03: one poll or quiz of a room. Reached only from inside the room (its page, or D04's side panel),
 * never from Explore, a notification or the universe. Optional, unscored and kept in the room.
 */
export function ActivityScreen(params: { readonly roomId: string; readonly activityId: string }) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {!isRoomId(params.roomId) || !isRoomId(params.activityId) ? (
        <StateBlock title="This isn’t available" body="Check the address and try again." />
      ) : state.status === 'signed_in' ? (
        <OpenActivity
          key={params.activityId}
          scope={state.scope}
          roomId={params.roomId}
          activityId={params.activityId}
        />
      ) : state.status === 'unavailable' ? (
        <StateBlock
          title="Can’t reach your account"
          body="Reconnect to see this."
          actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
        />
      ) : (
        <StateBlock
          title="Sign in to see this"
          actions={[
            {
              label: 'Sign in',
              variant: 'primary',
              role: 'link',
              href: '/welcome',
              onPress: () => router.navigate('/welcome'),
            },
          ]}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  body: {
    gap: spacing[4],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  moderation: { gap: spacing[2], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.freshTint },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
