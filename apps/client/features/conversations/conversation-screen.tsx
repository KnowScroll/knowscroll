import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TALK_QUERY_KEY, findConversation, type AccountScope } from '@knowscroll/client-core';
import type { DirectConversationRef } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing, universe } from '@knowscroll/design-tokens';
import { Skeleton, StateBlock, Text, useDisplay } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { TalkFrame } from '../shell/talk-frame';
import { conversationRefFromParams } from './conversation-links';
import { PANE_LIST_WIDTH, TalkList } from './conversations-screen';
import { useTalkListLook } from './talk-list-look';
import { Thread } from './thread-view';
import { ThreadHeader } from './thread-header';
import { useConversationThread } from './use-conversation-thread';

function OpenThread({ scope, reference }: { readonly scope: AccountScope; readonly reference: DirectConversationRef }) {
  const { controller, state } = useConversationThread(scope, reference);
  return <Thread scope={scope} controller={controller} state={state} reference={reference} />;
}

/** The reference to open: carried by the address, or found in the person's own inbox by ID. */
function ResolvedThread({
  scope,
  params,
}: {
  readonly scope: AccountScope;
  readonly params: {
    readonly conversationId: string;
    readonly m?: string | undefined;
    readonly r?: string | undefined;
  };
}) {
  const router = useRouter();
  const carried = conversationRefFromParams(params);
  const lookup = useQuery({
    queryKey: scope.queryKey(TALK_QUERY_KEY, 'find', params.conversationId),
    enabled: carried === undefined,
    queryFn: async () => (await findConversation(scope, newCommandId, params.conversationId)) ?? null,
    staleTime: 60_000,
  });
  const reference = carried ?? lookup.data ?? undefined;
  if (reference !== undefined) return <OpenThread key={reference.conversationId} scope={scope} reference={reference} />;
  if (lookup.isPending)
    return (
      <View style={styles.body}>
        <Skeleton rows={4} label="Loading conversation" />
      </View>
    );
  return (
    <StateBlock
      title="This conversation isn’t available"
      body="It may have ended, or you may no longer have access."
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
}

/**
 * C02: one direct conversation. Messages are read in order from the server, new ones arrive on a
 * live hint (or the next poll, focus or reconnect), and a message being sent stays one bubble
 * until the server's receipt. Opening the thread and reading it records nothing about anyone.
 */
export function ConversationScreen(params: {
  readonly conversationId: string;
  readonly m?: string | undefined;
  readonly r?: string | undefined;
}) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // From 1024 px the inbox stays beside the open conversation (D03).
  const withInbox = useDisplay().breakpoint === 'desktop' && state.status === 'signed_in';
  const look = useTalkListLook();
  const screen = (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {state.status === 'signed_in' ? (
        <ResolvedThread scope={state.scope} params={params} />
      ) : (
        <>
          <ThreadHeader
            peer={undefined}
            fallbackName="Conversation"
            onBack={() => router.replace('/conversations')}
            onMenu={undefined}
          />
          {state.status === 'unavailable' ? (
            <StateBlock
              title="Can’t reach your account"
              body="Reconnect to read this conversation."
              actions={[{ label: 'Reconnect', onPress: () => void manager.refresh() }]}
            />
          ) : (
            <StateBlock
              title="Sign in to read this conversation"
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
        </>
      )}
    </KeyboardAvoidingView>
  );
  // The inbox is a sibling before a conversation wrapper that is always there, so a resize across
  // 1024 px adds or removes only the inbox: the open conversation keeps its controller, its
  // reads, its socket and any message still being sent.
  return (
    <TalkFrame>
      <View style={styles.panes}>
        {withInbox && state.status === 'signed_in' ? (
          <View
            role="complementary"
            aria-label="Conversations"
            style={[styles.inbox, { backgroundColor: look.dark ? universe.sky : content.paper }]}
          >
            <ScrollView contentContainerStyle={styles.inboxContent}>
              <Text variant="title" heading={2} color={look.text}>
                Talk
              </Text>
              <TalkList scope={state.scope} currentId={params.conversationId} />
            </ScrollView>
          </View>
        ) : null}
        <View style={withInbox ? styles.conversation : styles.fill}>{screen}</View>
      </View>
    </TalkFrame>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  panes: { flex: 1, minHeight: 0, flexDirection: 'row' },
  fill: { flex: 1, minWidth: 0, minHeight: 0 },
  inbox: {
    width: PANE_LIST_WIDTH + 2 * layout.gutter,
    borderRightWidth: borderWidth.regular,
    borderRightColor: content.ink,
  },
  inboxContent: { padding: layout.gutter, gap: spacing[3] },
  conversation: { flex: 1, minWidth: 340, minHeight: 0 },
  body: { padding: layout.gutter },
});
