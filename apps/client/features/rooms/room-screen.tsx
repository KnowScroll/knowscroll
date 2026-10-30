import { useRouter } from 'expo-router';
import { useContext, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomJoinBlock, RoomView } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, space, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, Skeleton, StateBlock, Tag, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { ActivitiesSection } from './activities-section';
import { AiHere } from './ai-here';
import { GeneralStage, PhoneRoom } from './campfire';
import { isRoomId } from './room-links';
import { Guidelines, ModeratorTools, RULE_WORDS, WhoIsHere } from './room-parts';
import { RoomWorkspaceContext } from './room-workspace-context';
import { TopicsList } from './topics-list';
import { useRoom, useRoomActivities } from './use-room';

type Preview = Extract<RoomView, { status: 'preview' }>;
type Member = Extract<RoomView, { status: 'member' }>;

/** The dark header both the preview and the room share (R01 "rhead"). */
export function RoomHeader({
  name,
  onBack,
  children,
}: {
  readonly name: string;
  readonly onBack: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <IconButton icon="back" label="Back" variant="onSpace" onPress={onBack} />
      <Text variant="monoXs" color={space.label2}>
        Cosmic room
      </Text>
      <Text variant="displayL" color={space.label} heading={1}>
        {name}
      </Text>
      {children}
    </View>
  );
}

const BLOCKS: Record<RoomJoinBlock, { tag?: string; title: string; body: string; action?: 'friends' | 'talk' }> = {
  invite_only: {
    tag: 'Invite-only',
    title: 'This room is invite-only. Ask a member.',
    body: 'If a friend is in it, they can send you an invite from the room.',
    action: 'talk',
  },
  friend_of_member_needed: {
    tag: 'Friends of members',
    title: 'A friend of a member can join',
    body: 'Someone you’re friends with needs to be in this room first, or a member can invite you.',
    action: 'friends',
  },
  profile_needed: {
    title: 'Choose a name first',
    body: 'Rooms show people by name. Pick a handle and a display name in Friends, then come back.',
    action: 'friends',
  },
  paused: { tag: 'Paused', title: 'Paused by the moderator', body: 'New people can join once the room is open again.' },
  closed: { tag: 'Closed', title: 'This room is closed', body: 'It isn’t taking new people.' },
  removed: { title: 'You’re no longer a member', body: 'A moderator removed you from this room.' },
};

/** R01 "Access required · paused": the honest reason a person cannot join yet, with the way forward if there is one. */
function JoinBlockCard({ reason }: { readonly reason: RoomJoinBlock }) {
  const router = useRouter();
  const block = BLOCKS[reason];
  return (
    <View style={styles.block} accessibilityLiveRegion="polite">
      {block.tag === undefined ? null : <Tag label={block.tag} />}
      <Text variant="ui">{block.title}</Text>
      <Text variant="bodyS" color={content.ink2}>
        {block.body}
      </Text>
      {block.action === undefined ? null : (
        <Button
          label={block.action === 'talk' ? 'Message a friend' : 'Open Friends'}
          size="sm"
          onPress={() => router.push(block.action === 'talk' ? '/conversations' : '/friends')}
        />
      )}
    </View>
  );
}

/** R01 "Room preview": who the room is for and who is here to help, before joining. Nothing counts people. */
export function PreviewBody({
  view,
  controller,
  state,
}: {
  readonly view: Preview;
  readonly controller: RoomController;
  readonly state: RoomState;
}) {
  return (
    <>
      <View style={styles.padded}>
        <Text variant="body">{view.room.description}</Text>
        <WhoIsHere hasModerator={view.hasModerator} inhabitants={view.inhabitants} />
        {view.pinned === undefined ? null : (
          <View style={styles.pinned}>
            <Text variant="monoXs" color={content.ink2}>
              Pinned question
            </Text>
            <Text variant="ui">{view.pinned}</Text>
          </View>
        )}
        {view.guidelines === undefined ? null : <Guidelines text={view.guidelines} />}
      </View>
      <View style={styles.footer}>
        {view.join.allowed ? (
          <>
            <Button
              label="Join room"
              variant="primary"
              fullWidth
              busy={state.working}
              busyLabel="Joining"
              onPress={() => void controller.join()}
              testID="join-room"
            />
            <Text variant="metaS" color={content.ink2} align="center">
              Joining doesn’t change your universe.
            </Text>
          </>
        ) : (
          <JoinBlockCard reason={view.join.reason} />
        )}
        {state.refused ? (
          <Banner kind="error" lead="Couldn’t join." message="The room has changed. Here is how it stands now." />
        ) : null}
      </View>
    </>
  );
}

/** R03's way in on a phone: the room's polls and quizzes under its threads. */
function PageActivities({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const { controller, state } = useRoomActivities(scope, roomId);
  return <ActivitiesSection roomId={roomId} state={state} controller={controller} />;
}

/**
 * The room's details as one page: what it is for, who is here to help, its discussions with the ways to start one,
 * its polls and quizzes, the guidelines, a moderator's tools and Leave. On a phone these live behind the room's name
 * (`RoomMenu`); D04's left pane shows them as the rail, with General first and the member's own AI settings.
 */
export function MemberBody({
  scope,
  view,
  controller,
  state,
  rail,
  selectedDiscussionId,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  /** D04's left pane: no activity here (it has its own pane), General leads the list and the open discussion is marked. */
  readonly rail?: boolean;
  readonly selectedDiscussionId?: string;
}) {
  const moderator = view.role === 'moderator';
  return (
    <View style={styles.padded}>
      <Text variant="bodyS" color={content.ink2}>
        {view.room.description}
      </Text>
      <WhoIsHere hasModerator={view.hasModerator} inhabitants={view.inhabitants} stacked={rail === true} />
      {!view.canPost ? (
        <Banner
          kind="info"
          lead={view.room.status === 'closed' ? 'This room is closed.' : 'Paused by the moderator.'}
          message="You can read earlier messages. New messages are off for now."
        />
      ) : null}
      <TopicsList
        scope={scope}
        view={view}
        controller={controller}
        state={state}
        {...(selectedDiscussionId === undefined ? {} : { selectedDiscussionId })}
        {...(rail === true ? { general: { selected: selectedDiscussionId === undefined } } : {})}
      />
      {rail === true ? (
        <>
          <View style={styles.railSection} testID="rail-ai-here">
            <Text variant="monoXs" color={content.ink2}>
              AI here
            </Text>
            <AiHere
              you={view.you}
              working={state.working}
              onChange={(change) => void controller.setPreferences(change)}
            />
          </View>
          <Text variant="meta" color={content.ink2} testID="rail-members">
            {`Members · ${String(view.memberTotal)}`}
          </Text>
        </>
      ) : (
        <PageActivities scope={scope} roomId={view.room.roomId} />
      )}
      {view.guidelines === undefined ? null : <Guidelines text={view.guidelines} />}
      {moderator ? <ModeratorTools scope={scope} view={view} controller={controller} state={state} /> : null}
      <Button
        label="Leave room"
        variant="ghost"
        size="sm"
        busy={state.working}
        onPress={() => void controller.leave()}
        testID="leave-room"
      />
    </View>
  );
}

/** One room as a full page: the preview for an outsider, the campfire (General under the room's band) for a member. */
function RoomPage({
  scope,
  controller,
  state,
}: {
  readonly scope: AccountScope;
  readonly controller: RoomController;
  readonly state: RoomState;
}) {
  const router = useRouter();
  const view = state.view;
  useDocumentTitle(view?.room.name ?? 'Room');
  const back = () => (router.canGoBack() ? router.back() : router.replace('/conversations'));
  if (state.phase === 'loading')
    return (
      <View style={styles.padded}>
        <Skeleton rows={4} label="Loading room" />
      </View>
    );
  if (state.phase === 'failed')
    return (
      <StateBlock
        title="Can’t open this room"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    );
  if (view === undefined)
    return (
      <StateBlock
        title="This room isn’t available"
        body="It may have closed, or the address may be wrong."
        actions={[
          {
            label: 'Back to Talk',
            role: 'link',
            href: '/conversations',
            onPress: () => router.replace('/conversations'),
          },
        ]}
      />
    );
  if (view.status === 'member')
    return (
      <>
        {state.offline ? (
          <View style={styles.padded}>
            <Banner kind="offline" lead="Offline." message="This may be out of date." />
          </View>
        ) : null}
        <PhoneRoom scope={scope} view={view} controller={controller} state={state} onBack={back} />
      </>
    );
  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="room-screen">
      <RoomHeader name={view.room.name} onBack={back}>
        <View style={styles.tags}>
          <Tag variant="onDark" label={RULE_WORDS[view.room.joinRule]} />
          {view.hasModerator ? <Tag variant="onDark" label="Moderated" /> : null}
          {view.invited ? <Tag variant="part" label="You’re invited" /> : null}
        </View>
      </RoomHeader>
      {state.offline ? (
        <View style={styles.padded}>
          <Banner kind="offline" lead="Offline." message="This may be out of date." />
        </View>
      ) : null}
      <PreviewBody view={view} controller={controller} state={state} />
    </ScrollView>
  );
}

/** A room opened on its own (a phone, a tablet): the screen reads it itself. */
function StandaloneRoom({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const { controller, state } = useRoom(scope, roomId);
  return <RoomPage scope={scope} controller={controller} state={state} />;
}

/** A room opened beside its own panes (D04): the layout already reads it, and a member's centre is General. */
function WorkspaceRoom({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const workspace = useContext(RoomWorkspaceContext);
  if (workspace === undefined) return <StandaloneRoom scope={scope} roomId={roomId} />;
  const view = workspace.state.view;
  if (workspace.panes && view?.status === 'member')
    return (
      <View style={styles.centreHome} testID="room-workspace-home">
        <GeneralStage
          scope={scope}
          view={view}
          controller={workspace.controller}
          state={workspace.state}
          header={null}
        />
      </View>
    );
  return <RoomPage scope={scope} controller={workspace.controller} state={workspace.state} />;
}

/**
 * R01 and R02's room list: a room is a station in the person's own geography with one identity.
 * Outsiders see who it is for and who is here to help, then join; members see the room's discussions.
 * No member, activity or online count is shown anywhere, and joining never changes the universe.
 */
export function RoomScreen({ roomId }: { readonly roomId: string }) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingBottom: insets.bottom }]}
    >
      {!isRoomId(roomId) ? (
        <StateBlock title="This room isn’t available" body="Check the address and try again." />
      ) : state.status === 'signed_in' ? (
        <WorkspaceRoom key={roomId} scope={state.scope} roomId={roomId} />
      ) : state.status === 'unavailable' ? (
        <StateBlock
          title="Can’t reach your account"
          body="Reconnect to see this room."
          actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
        />
      ) : (
        <StateBlock
          title="Sign in to see this room"
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
  scroll: { flexGrow: 1 },
  centreHome: { flex: 1 },
  railSection: { gap: spacing[2], paddingTop: spacing[2] },
  header: {
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingTop: spacing[12],
    paddingBottom: spacing[5],
    backgroundColor: space.s0,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  padded: {
    gap: spacing[4],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  pinned: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper2,
  },
  footer: {
    gap: spacing[2],
    padding: layout.gutter,
    width: '100%',
    maxWidth: layout.measureDesktop,
    alignSelf: 'center',
  },
  block: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
  },
});
