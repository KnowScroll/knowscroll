import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { inboxRowView, listTime, type AccountScope } from '@knowscroll/client-core';
import type { DirectConversationSummary } from '@knowscroll/contracts';
import { borderWidth, content, dimension, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, RowLink, Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useAccountScopeIfPresent } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { EmptyTalk } from './empty-talk-screen';
import { PersonAvatar } from './person-avatar';
import { conversationHref } from './conversation-links';
import { useTalkInbox } from './use-talk-inbox';

function InboxRow({ item }: { readonly item: DirectConversationSummary }) {
  const router = useRouter();
  const view = inboxRowView(item);
  const href = conversationHref(item.conversation);
  const time = view.at === undefined ? undefined : listTime(view.at, new Date());
  const name = item.peer.displayName;
  const preview = item.ended === true ? `${view.preview} · ${name} left` : view.preview;
  return (
    <View style={styles.rowFrame}>
      <RowLink
        label={`${name}${view.unread ? ', unread' : ''}, ${preview}${time === undefined ? '' : `, ${time}`}`}
        href={href}
        onPress={() => router.push(href)}
        testID={`talk-row-${item.conversation.conversationId}`}
      >
        <View style={styles.row}>
          <PersonAvatar person={item.peer} />
          <View style={styles.rowText}>
            <Text variant={view.unread ? 'ui' : 'bodyS'} numberOfLines={1}>
              {name}
            </Text>
            <Text variant="meta" color={content.ink2} numberOfLines={1}>
              {preview}
            </Text>
          </View>
          <View style={styles.rowEnd}>
            {time === undefined ? null : (
              <Text variant="monoXs" color={content.ink2}>
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

function SignedInTalk({ scope }: { readonly scope: AccountScope }) {
  const inbox = useTalkInbox(scope);
  if (inbox.loading) return <Skeleton rows={4} label="Loading conversations" />;
  if (inbox.failed && inbox.items.length === 0)
    return (
      <StateBlock
        title="Can't load conversations"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: inbox.retry }]}
      />
    );
  if (inbox.items.length === 0) return <EmptyTalk />;
  return (
    <View>
      {inbox.failed ? (
        <View style={styles.banner}>
          <Banner kind="offline" lead="Offline." message="This list may be out of date." />
        </View>
      ) : null}
      <View role="list" accessibilityLabel="Conversations">
        {inbox.items.map((item) => (
          <View key={item.conversation.conversationId} role="listitem">
            <InboxRow item={item} />
          </View>
        ))}
      </View>
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

/** C01: Talk, the inbox of real conversations. Reading or opening it records nothing about anyone. */
export function ConversationsScreen() {
  const { state, manager } = useAccountScopeIfPresent();
  return (
    <ScreenFrame tone="paper" title="Talk" bodyOffset={dimension.stateOffsetPhone.talk}>
      {state.status === 'signed_in' ? (
        <SignedInTalk scope={state.scope} />
      ) : state.status === 'unavailable' && manager !== undefined ? (
        <StateBlock
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

const styles = StyleSheet.create({
  rowFrame: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  rowText: { flex: 1, gap: spacing['0.5'] },
  rowEnd: { alignItems: 'flex-end', gap: spacing[2], minWidth: 44 },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: content.accent },
  banner: { marginBottom: spacing[3] },
  more: { paddingVertical: spacing[4] },
});
