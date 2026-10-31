import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { inboxRowView, listTime, threadRowView, type AccountScope } from '@knowscroll/client-core';
import type { DirectConversationSummary } from '@knowscroll/contracts';
import { borderWidth, content, dimension, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, RowLink, Skeleton, StateBlock, Text, useDisplay } from '@knowscroll/ui';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyTalk } from './empty-talk-screen';
import { PersonAvatar } from './person-avatar';
import { NewTalkButton, useTalkHasContent } from './new-talk';
import { useTalkListLook } from './talk-list-look';
import { conversationHref } from './conversation-links';
import { useTalkInbox } from './use-talk-inbox';
import { InvitationCard } from '../threads/invitation-card';
import { ThreadRow } from '../threads/thread-row';
import { useThreadInbox } from '../threads/use-thread-inbox';
import { RoomRow } from '../rooms/room-row';
import { useRoomList } from '../rooms/use-room';

function InboxRow({ item, current }: { readonly item: DirectConversationSummary; readonly current: boolean }) {
  const router = useRouter();
  const view = inboxRowView(item);
  const href = conversationHref(item.conversation);
  const time = view.at === undefined ? undefined : listTime(view.at, new Date());
  const name = item.peer.displayName;
  const preview = item.ended === true ? `${view.preview} · ${name} left` : view.preview;
  const look = useTalkListLook();
  return (
    <View style={[styles.rowFrame, { borderBottomColor: look.rule }]}>
      <RowLink
        label={`${name}${view.unread ? ', unread' : ''}, ${preview}${time === undefined ? '' : `, ${time}`}`}
        href={href}
        onPress={() => router.push(href)}
        current={current}
        tint={look.tint}
        testID={`talk-row-${item.conversation.conversationId}`}
      >
        <View style={styles.row}>
          <PersonAvatar person={item.peer} />
          <View style={styles.rowText}>
            <Text variant={view.unread ? 'ui' : 'bodyS'} color={look.text} numberOfLines={1}>
              {name}
            </Text>
            <Text variant="meta" color={look.quiet} numberOfLines={1}>
              {preview}
            </Text>
          </View>
          <View style={styles.rowEnd}>
            {time === undefined ? null : (
              <Text variant="monoXs" color={look.quiet}>
                {time}
              </Text>
            )}
            {view.unread ? <View style={styles.unreadDot} /> : null}
          </View>
        </View>
      </RowLink>
    </View>
  );
}

/** The person's conversations and threads, newest first; `currentId` marks the one open beside the list. */
export function TalkList({ scope, currentId }: { readonly scope: AccountScope; readonly currentId?: string }) {
  const inbox = useTalkInbox(scope);
  const threads = useThreadInbox(scope);
  const rooms = useRoomList(scope);
  const look = useTalkListLook();
  if (inbox.loading || threads.loading) return <Skeleton rows={4} label="Loading conversations" />;
  if (inbox.failed && inbox.items.length === 0 && threads.items.length === 0 && rooms.items.length === 0)
    return (
      <StateBlock
        tone={look.tone}
        title="Can't load conversations"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: inbox.retry }]}
      />
    );
  if (inbox.items.length === 0 && threads.items.length === 0 && rooms.items.length === 0) return <EmptyTalk />;
  // An invitation is a card above the list (C03), not a row; the rest share one list, newest first.
  const invitations = threads.items.filter((item) => item.state === 'invited');
  const rows = [
    ...inbox.items.map((item) => ({
      key: item.conversation.conversationId,
      at: inboxRowView(item).at?.getTime() ?? 0,
      node: <InboxRow item={item} current={item.conversation.conversationId === currentId} />,
    })),
    ...threads.items
      .filter((item) => item.state !== 'invited')
      .map((item) => ({
        key: item.thread.threadId,
        at: threadRowView(item).at.getTime(),
        node: <ThreadRow item={item} />,
      })),
  ].sort((first, second) => second.at - first.at);
  return (
    <View style={styles.list}>
      {inbox.failed || threads.failed ? (
        <View style={styles.banner}>
          <Banner kind="offline" lead="Offline." message="This list may be out of date." />
        </View>
      ) : null}
      {invitations.map((item) => (
        <InvitationCard key={item.thread.threadId} scope={scope} item={item} />
      ))}
      <View role="list" accessibilityLabel="Conversations">
        {rows.map((row) => (
          <View key={row.key} role="listitem">
            {row.node}
          </View>
        ))}
      </View>
      {rooms.items.length === 0 ? null : (
        <View style={styles.rooms}>
          <Text variant="monoXs" color={look.quiet}>
            Rooms
          </Text>
          <View role="list" accessibilityLabel="Rooms">
            {rooms.items.map((item) => (
              <View key={item.room.roomId} role="listitem">
                <RoomRow item={item} />
              </View>
            ))}
          </View>
        </View>
      )}
      {inbox.hasMore ? (
        <View style={styles.more}>
          <Button
            label="Show older conversations"
            busy={inbox.loadingMore}
            busyLabel="Loading"
            onPress={inbox.loadMore}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A signed-in person's Talk: C01 draws New where the account avatar sits, with the list right under the title. */
function SignedInTalk({ scope, desktop }: { readonly scope: AccountScope; readonly desktop: boolean }) {
  const listed = useTalkHasContent(scope);
  const look = useTalkListLook();
  return (
    <ScreenFrame
      tone={look.tone}
      title="Talk"
      bodyOffset={listed ? spacing[3] : dimension.stateOffsetPhone.talk}
      trailing={listed ? <NewTalkButton /> : undefined}
    >
      {desktop ? (
        <View style={styles.panes}>
          <View style={styles.listPane}>
            <TalkList scope={scope} />
          </View>
          <View style={[styles.emptyPane, { borderColor: look.text }]}>
            <Text variant="heading" heading={2} color={look.text}>
              Pick a conversation
            </Text>
            <Text variant="bodyS" color={look.quiet}>
              It opens here, beside the list.
            </Text>
          </View>
        </View>
      ) : (
        <TalkList scope={scope} />
      )}
    </ScreenFrame>
  );
}

/**
 * C01: Talk, the inbox of real conversations. Reading or opening it records nothing about anyone.
 * From 1024 px (D03) the list has a pane beside it, where a chosen conversation opens; until one
 * is chosen the pane says so.
 */
export function ConversationsScreen() {
  const { state, manager } = useAccountScopeIfPresent();
  const desktop = useDisplay().breakpoint === 'desktop';
  const look = useTalkListLook();
  if (state.status === 'signed_in') return <SignedInTalk scope={state.scope} desktop={desktop} />;
  return (
    <ScreenFrame tone={look.tone} title="Talk" bodyOffset={dimension.stateOffsetPhone.talk}>
      {state.status === 'unavailable' && manager !== undefined ? (
        <StateBlock
          tone={look.tone}
          title="Can't reach your account"
          body="Reconnect to see your conversations."
          actions={[
            {
              label: 'Reconnect',
              onPress: () => {
                void manager.refresh();
              },
            },
          ]}
        />
      ) : (
        // Signed out there is nothing to list: the same first-visit screen, whose actions lead on.
        <EmptyTalk />
      )}
    </ScreenFrame>
  );
}

/** The inbox pane beside an open conversation (D03). */
export const PANE_LIST_WIDTH = 380;

const styles = StyleSheet.create({
  /** On wide screens rows keep the reading measure. */
  list: { width: '100%', maxWidth: layout.measureDesktop },
  panes: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing[8] },
  listPane: { width: PANE_LIST_WIDTH },
  emptyPane: {
    flex: 1,
    minHeight: 240,
    justifyContent: 'center',
    gap: spacing[2],
    padding: spacing[8],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: 'dashed',
    borderRadius: radius.panel,
  },
  rowFrame: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  rowText: { flex: 1, gap: spacing['0.5'] },
  rowEnd: { alignItems: 'flex-end', gap: spacing[2], minWidth: 44 },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: content.accent },
  banner: { marginBottom: spacing[3] },
  rooms: { gap: spacing[2], paddingTop: spacing[5] },
  more: { paddingVertical: spacing[4] },
});
