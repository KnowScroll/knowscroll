import { useGlobalSearchParams, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import type { RoomHere } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ActivitiesSection } from './activities-section';
import { PollCard } from './poll-card';
import { HereNow, HereStrip } from './here-strip';
import { BandTag } from './identity/band-tag';
import { RULE_WORDS } from './room-parts';
import { MemberBody, RoomHeader } from './room-screen';
import { isRoomId } from './room-links';
import { RoomWorkspaceContext } from './room-workspace-context';
import { useRoom, useRoomActivities, useRoomActivity } from './use-room';

const LEFT_WIDTH = 304;
const RIGHT_WIDTH = 288;

/** The newest open poll, read in place with the same controller as its own screen (D04 "Room extras"). */
function InlinePoll({
  scope,
  roomId,
  activityId,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly activityId: string;
}) {
  const { controller, state } = useRoomActivity(scope, roomId, activityId);
  const view = state.view;
  if (view === undefined || view.activity.kind !== 'poll') return null;
  return <PollCard view={view} poll={view.activity} state={state} controller={controller} compact />;
}

/** D04's right pane: the room's optional activity, never more than a poll in place and a list. */
function RoomExtras({
  scope,
  roomId,
  here,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly here: RoomHere;
}) {
  const { controller, state } = useRoomActivities(scope, roomId);
  const poll = state.activities.find((item) => item.kind === 'poll' && item.state === 'open');
  return (
    <View style={styles.extras} testID="room-extras">
      <HereNow here={here} />
      <Text variant="monoXs" color={content.ink2}>
        Room extras
      </Text>
      {poll === undefined ? (
        <Text variant="meta" color={content.ink2}>
          No poll right now. Polls and quizzes are optional and only ever in this room.
        </Text>
      ) : (
        <InlinePoll scope={scope} roomId={roomId} activityId={poll.activityId} />
      )}
      <ActivitiesSection roomId={roomId} state={state} controller={controller} />
    </View>
  );
}

function Panes({
  scope,
  roomId,
  children,
}: {
  readonly scope: AccountScope;
  readonly roomId: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const { controller, state } = useRoom(scope, roomId);
  const { discussionId } = useGlobalSearchParams<{ discussionId?: string }>();
  const view = state.view;
  const member = view?.status === 'member' ? view : undefined;
  const value = { controller, state, panes: member !== undefined };
  const back = () => (router.canGoBack() ? router.back() : router.replace('/conversations'));
  return (
    <RoomWorkspaceContext.Provider value={value}>
      {member === undefined ? (
        children
      ) : (
        <View style={styles.row} testID="room-workspace">
          <ScrollView style={styles.left} contentContainerStyle={styles.leftContent} testID="room-rail">
            <RoomHeader name={member.room.name} identity={member.room.identity} onBack={back}>
              <View style={styles.tags}>
                <BandTag label={RULE_WORDS[member.room.joinRule]} />
                {member.hasModerator ? <BandTag label="Moderated" /> : null}
                {member.launch?.state === 'lobby' || member.launch?.state === 'live' ? (
                  <BandTag label="Launch live" testID="band-live" />
                ) : null}
              </View>
              <HereStrip here={member.here} lastMessageAt={member.lastMessageAt} />
            </RoomHeader>
            <MemberBody
              scope={scope}
              view={member}
              controller={controller}
              state={state}
              rail
              {...(discussionId === undefined ? {} : { selectedDiscussionId: discussionId })}
            />
          </ScrollView>
          <View style={styles.centre}>{children}</View>
          <ScrollView style={styles.right} contentContainerStyle={styles.rightContent}>
            {member === undefined ? null : <RoomExtras scope={scope} roomId={roomId} here={member.here} />}
          </ScrollView>
        </View>
      )}
    </RoomWorkspaceContext.Provider>
  );
}

/**
 * D04: a room at desktop width. A member sees three panes at once: the room and its threads on the
 * left, the open discussion (or poll) in the centre, the optional room extras on the right. An outsider
 * sees the preview alone. It is the same screens as a phone's, side by side: the panes read nothing a
 * phone does not, and nothing here is evidence.
 */
export function RoomWorkspace({ roomId, children }: { readonly roomId: string; readonly children: ReactNode }) {
  const { state } = useAccountScope();
  if (!isRoomId(roomId) || state.status !== 'signed_in') return <>{children}</>;
  return (
    <Panes key={roomId} scope={state.scope} roomId={roomId}>
      {children}
    </Panes>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', backgroundColor: content.paper },
  left: {
    width: LEFT_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    borderRightWidth: borderWidth.regular,
    borderRightColor: content.ink,
  },
  leftContent: { flexGrow: 1 },
  centre: { flex: 1, minWidth: 0 },
  right: {
    width: RIGHT_WIDTH,
    flexGrow: 0,
    flexShrink: 0,
    borderLeftWidth: borderWidth.regular,
    borderLeftColor: content.ink,
  },
  rightContent: { flexGrow: 1 },
  extras: { gap: spacing[4], padding: layout.gutter },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
