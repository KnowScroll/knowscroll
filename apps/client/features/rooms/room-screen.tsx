import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope, RoomController, RoomState } from '@knowscroll/client-core';
import type { RoomDiscussionSummary, RoomInhabitant, RoomJoinBlock, RoomView } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, space, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, IconButton, Skeleton, StateBlock, Tag, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { AiLabel, ModeratorLabel } from './ai-label';
import { discussionHref, isRoomId } from './room-links';
import { ShareIntoRoomSheet } from './share-into-room-sheet';
import { useRoom } from './use-room';

type Preview = Extract<RoomView, { status: 'preview' }>;
type Member = Extract<RoomView, { status: 'member' }>;

const RULE_WORDS = {
  open: 'Open to everyone',
  friends_of_members: 'Open to friends of members',
  invite_only: 'Invite-only',
} as const;

/** The dark header both the preview and the room share (R01 "rhead"). */
function RoomHeader({
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

function Guidelines({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.guidelines}>
      <Pressable role="button" aria-expanded={open} onPress={() => setOpen(!open)} style={styles.guidelinesToggle}>
        <Text variant="ui">Room guidelines</Text>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={18} color={content.ink} />
      </Pressable>
      {open ? (
        <Text variant="bodyS" color={content.ink2}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** Who the room has beside people: a moderator when there is one, and the labelled AI inhabitants. */
function WhoIsHere({
  hasModerator,
  inhabitants,
}: {
  readonly hasModerator: boolean;
  readonly inhabitants: readonly RoomInhabitant[];
}) {
  return (
    <View style={styles.who} role="list" accessibilityLabel="Who is here to help">
      <Text variant="monoXs" color={content.ink2}>
        Who’s here to help
      </Text>
      {hasModerator ? (
        <View role="listitem" style={styles.whoRow}>
          <ModeratorLabel />
          <Text variant="bodyS">Keeps the discussion on track</Text>
        </View>
      ) : null}
      {inhabitants.map((entry) => (
        <View key={entry.inhabitant} role="listitem" style={styles.whoRow}>
          <AiLabel label={entry.label} />
          <Text variant="bodyS">{entry.blurb}</Text>
        </View>
      ))}
      {inhabitants.length === 0 ? null : (
        <Text variant="meta" color={content.ink2}>
          AI inhabitants are labelled and never pretend to be people.
        </Text>
      )}
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

function DiscussionRow({ roomId, item }: { readonly roomId: string; readonly item: RoomDiscussionSummary }) {
  const router = useRouter();
  const metadata =
    item.root?.status === 'available'
      ? item.root.metadata
      : item.root?.status === 'corrected'
        ? item.root.current.metadata
        : undefined;
  const kind =
    metadata === undefined
      ? item.root === undefined
        ? undefined
        : 'content'
      : metadata.kind === 'reel'
        ? 'Reel'
        : 'Scroll';
  const subtitle = [
    kind ?? 'Discussion',
    item.startedBy === undefined ? undefined : `started by ${item.startedBy.displayName}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
  const href = discussionHref(roomId, item.discussionId);
  return (
    <Pressable
      role="link"
      accessibilityLabel={`${item.pinned ? 'Pinned by the moderator. ' : ''}${item.title}, ${subtitle}`}
      onPress={() => router.push(href)}
      style={[styles.row, item.pinned ? styles.rowPinned : null]}
      testID={`discussion-${item.discussionId}`}
    >
      {item.pinned ? (
        <View style={styles.pinnedLabel}>
          <Icon name="shield" size={12} color={content.freshInk} />
          <Text variant="metaS" color={content.freshInk}>
            Pinned by the moderator
          </Text>
        </View>
      ) : null}
      <View style={styles.rowMain}>
        <View style={styles.tile} aria-hidden>
          <Icon
            name={metadata?.kind === 'scroll' ? 'scroll' : metadata?.kind === 'reel' ? 'reel' : 'ask'}
            size={20}
            color={content.paper}
          />
        </View>
        <View style={styles.rowText}>
          <Text variant="ui" numberOfLines={2}>
            {item.title}
          </Text>
          <Text variant="meta" color={content.ink2} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** R02 "Room · threads": the room's discussions, pinned first, and the ways to start one. */
export function MemberBody({
  scope,
  view,
  controller,
  state,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
}) {
  const router = useRouter();
  const [sharing, setSharing] = useState(false);
  const moderator = view.role === 'moderator';
  return (
    <>
      <View style={styles.padded}>
        <Text variant="bodyS" color={content.ink2}>
          {view.room.description}
        </Text>
        <WhoIsHere hasModerator={view.hasModerator} inhabitants={view.inhabitants} />
        {!view.canPost ? (
          <Banner
            kind="info"
            lead={view.room.status === 'closed' ? 'This room is closed.' : 'Paused by the moderator.'}
            message="You can read earlier messages. New messages are off for now."
          />
        ) : null}
        <View style={styles.listHeader}>
          <Text variant="monoXs" color={content.ink2}>
            Threads
          </Text>
          {view.canPost ? (
            <Button
              label="Share into room"
              size="sm"
              variant="primary"
              onPress={() => setSharing(true)}
              testID="share-into-room"
            />
          ) : null}
        </View>
        {view.discussions.length === 0 ? (
          <View style={styles.quiet}>
            <Text variant="ui">Nothing here yet</Text>
            <Text variant="meta" color={content.ink2}>
              Be the first to start a discussion. People who join will find it here.
            </Text>
          </View>
        ) : (
          <View role="list" accessibilityLabel="Discussions in this room" style={styles.rows}>
            {view.discussions.map((item) => (
              <View key={item.discussionId} role="listitem">
                <DiscussionRow roomId={view.room.roomId} item={item} />
              </View>
            ))}
          </View>
        )}
        {view.guidelines === undefined ? null : <Guidelines text={view.guidelines} />}
        {moderator ? (
          <View style={styles.moderation}>
            <Text variant="metaS" color={content.freshInk}>
              Moderator tools
            </Text>
            {view.room.status === 'open' ? (
              <Button
                label="Pause the room"
                size="sm"
                busy={state.working}
                onPress={() => void controller.moderate({ kind: 'pause' })}
              />
            ) : view.room.status === 'paused' ? (
              <Button
                label="Resume the room"
                size="sm"
                busy={state.working}
                onPress={() => void controller.moderate({ kind: 'resume' })}
              />
            ) : null}
            <Text variant="meta" color={content.ink2}>
              Pinning and removing messages are on each discussion. Nothing here changes anyone’s universe.
            </Text>
          </View>
        ) : null}
        <Button
          label="Leave room"
          variant="ghost"
          size="sm"
          busy={state.working}
          onPress={() => void controller.leave()}
          testID="leave-room"
        />
      </View>
      <ShareIntoRoomSheet
        scope={scope}
        visible={sharing}
        working={state.working}
        onClose={() => setSharing(false)}
        onStart={(start) =>
          void controller.startDiscussion(start).then((discussionId) => {
            if (discussionId === undefined) return;
            setSharing(false);
            router.push(discussionHref(view.room.roomId, discussionId));
          })
        }
      />
    </>
  );
}

function OpenRoom({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const router = useRouter();
  const { controller, state } = useRoom(scope, roomId);
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
  return (
    <ScrollView contentContainerStyle={styles.scroll} testID="room-screen">
      <RoomHeader name={view.room.name} onBack={back}>
        <View style={styles.tags}>
          <Tag variant="onDark" label={RULE_WORDS[view.room.joinRule]} />
          {view.hasModerator ? <Tag variant="onDark" label="Moderated" /> : null}
          {view.status === 'preview' && view.invited ? <Tag variant="part" label="You’re invited" /> : null}
        </View>
      </RoomHeader>
      {state.offline ? (
        <View style={styles.padded}>
          <Banner kind="offline" lead="Offline." message="This may be out of date." />
        </View>
      ) : null}
      {view.status === 'preview' ? (
        <PreviewBody view={view} controller={controller} state={state} />
      ) : (
        <MemberBody scope={scope} view={view} controller={controller} state={state} />
      )}
    </ScrollView>
  );
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
        <OpenRoom key={roomId} scope={state.scope} roomId={roomId} />
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
  who: { gap: spacing[2], paddingTop: spacing[2], borderTopWidth: borderWidth.hairline, borderTopColor: content.rule },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], minHeight: 44 },
  pinned: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper2,
  },
  guidelines: { gap: spacing[1] },
  guidelinesToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
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
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rows: { gap: spacing[2] },
  row: {
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  rowPinned: { backgroundColor: content.paper2 },
  pinnedLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.thumb,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.accent,
  },
  rowText: { flex: 1, gap: spacing['0.5'] },
  quiet: {
    gap: spacing[1],
    padding: spacing[4],
    borderRadius: radius.lg,
    borderWidth: borderWidth.light,
    borderColor: content.rule,
    backgroundColor: content.paper,
  },
  moderation: { gap: spacing[2], padding: spacing[3], borderRadius: radius.card, backgroundColor: content.freshTint },
});
