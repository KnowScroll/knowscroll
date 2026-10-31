import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { content } from '@knowscroll/design-tokens';
import { Skeleton, StateBlock } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { ThreadHeader } from '../threads/thread-chrome';
import { OpenDiscussion } from './discussion-screen';
import { isRoomId, roomHref } from './room-links';
import { TodayCards } from './today-cards';
import { dayHeading } from './today-words';
import { useRoomToday } from './use-room';

/**
 * A room's Today (R3 B "Today channel"): a daily channel with today's question and Spot the flaw above the day's talk, which
 * is an ordinary discussion (replies, Useful, asks) under the same rules as General. The items were approved by an operator
 * and each cites a library Scroll; the residents who ask them are labelled AI. A tap, an answer or a star here is play and
 * conversation, never evidence, and changes no one's universe.
 */
function TodayRoom({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const router = useRouter();
  const { controller, state } = useRoomToday(scope, roomId);
  const [focus, setFocus] = useState(0);
  const back = () => (router.canGoBack() ? router.back() : router.replace(roomHref(roomId)));
  useDocumentTitle('Today');
  const view = state.view;
  if (state.phase === 'loading') return <Skeleton rows={4} label="Loading Today" />;
  if (view === undefined)
    return state.phase === 'failed' ? (
      <StateBlock
        title="Can’t open Today"
        body="Check your connection and try again."
        actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
      />
    ) : (
      <StateBlock
        title="Today isn’t available"
        body="It may have ended, or you may no longer be in this room."
        actions={[{ label: 'Back to the room', role: 'link', href: roomHref(roomId), onPress: back }]}
      />
    );
  const resident = view.question?.by ?? view.flaw?.by;
  return (
    <OpenDiscussion
      key={view.discussionId}
      scope={scope}
      roomId={roomId}
      discussionId={view.discussionId}
      header={
        <ThreadHeader
          title="Today"
          people={`${dayHeading(view.day)}${resident === undefined ? '' : ` · asked by ${resident.name}, ${resident.label}`}`}
          onBack={back}
          onMenu={undefined}
        />
      }
      listHeader={
        <TodayCards view={view} state={state} controller={controller} onAnswer={() => setFocus((n) => n + 1)} />
      }
      focusSignal={focus}
    />
  );
}

/** `/rooms/<id>/today`: signed in, a member's Today; anything else is the same refusal as a room that is not there. */
export function RoomTodayScreen({ roomId }: { readonly roomId: string }) {
  const { state } = useAccountScope();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {!isRoomId(roomId) || state.status !== 'signed_in' ? (
        <StateBlock title="Today isn’t available" body="Sign in and open the room again." />
      ) : (
        <View style={styles.body}>
          <TodayRoom key={roomId} scope={state.scope} roomId={roomId} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: content.paper },
  body: { flex: 1 },
});
