import { useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AccountScope } from '@knowscroll/client-core';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { Skeleton, StateBlock, Text } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { useAccountScope } from '../../providers/account-scope';
import { ThreadHeader } from '../threads/thread-chrome';
import { ActivitiesSection } from './activities-section';
import { isRoomId, roomHref } from './room-links';
import { useRoomActivities } from './use-room';

function OpenActivities({ scope, roomId }: { readonly scope: AccountScope; readonly roomId: string }) {
  const router = useRouter();
  const { controller, state } = useRoomActivities(scope, roomId);
  useDocumentTitle('Room activity');
  const back = () => (router.canGoBack() ? router.back() : router.replace(roomHref(roomId)));
  return (
    <>
      <ThreadHeader title="Room activity" people="Optional · only in this room" onBack={back} onMenu={undefined} />
      <ScrollView contentContainerStyle={styles.body} testID="activities-screen">
        {state.phase === 'loading' ? <Skeleton rows={3} label="Loading" /> : null}
        {state.phase === 'unavailable' ? (
          <StateBlock
            title="This isn’t available"
            body="You may no longer be in this room."
            actions={[{ label: 'Back to the room', role: 'link', href: roomHref(roomId), onPress: back }]}
          />
        ) : null}
        {state.phase === 'failed' ? (
          <StateBlock
            title="Can’t load this"
            body="Check your connection and try again."
            actions={[{ label: 'Try again', onPress: () => void controller.load() }]}
          />
        ) : null}
        {state.phase === 'ready' ? (
          <>
            <ActivitiesSection roomId={roomId} state={state} controller={controller} all />
            {state.activities.length === 0 && !state.canCreate ? (
              <View style={styles.quiet}>
                <Text variant="ui">Nothing here</Text>
                <Text variant="meta" color={content.ink2}>
                  A moderator can start a poll or a quiz. Nobody has to join in.
                </Text>
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

/** The room's polls and quizzes, all of them (R03's list). Optional and kept in the room. */
export function ActivitiesScreen({ roomId }: { readonly roomId: string }) {
  const { state, manager } = useAccountScope();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      {!isRoomId(roomId) ? (
        <StateBlock title="This isn’t available" body="Check the address and try again." />
      ) : state.status === 'signed_in' ? (
        <OpenActivities key={roomId} scope={state.scope} roomId={roomId} />
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
  quiet: { gap: spacing[1], padding: spacing[4] },
});
