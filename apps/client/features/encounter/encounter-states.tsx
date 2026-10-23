import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, spacing } from '@knowscroll/design-tokens';
import { ErrorState, OfflineState, Skeleton, StateBlock, type StateAction } from '@knowscroll/ui';
import type { EncounterSession, EncounterState } from './encounter-session';
import { useEncounterMetrics } from './encounter-metrics';

function StateFrame({ children }: { readonly children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const metrics = useEncounterMetrics();
  return (
    <View style={styles.ground}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing[9], paddingBottom: metrics.bottom + spacing[6] },
        ]}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * Every state of Explore that is not a playing or ready encounter, in plain words and with the
 * next real step: opening, waiting, offline, a path that changed, a saved place that needs a
 * choice, an encounter that is no longer available, and a calm stop.
 */
export function EncounterStateScreen({
  state,
  session,
  calm,
  onLeaveCalm,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
  /** "Done for now": a quiet Explore, nothing playing until the person chooses. */
  readonly calm: boolean;
  /** Called before any action that leaves the calm state. */
  readonly onLeaveCalm: () => void;
}) {
  const router = useRouter();
  const entry = state.entry;
  const discover = () => {
    onLeaveCalm();
    session.open({ kind: 'discover' });
  };
  const returnAction: StateAction[] = entry
    ? [
        {
          label: 'Return to this encounter',
          onPress: () => {
            onLeaveCalm();
            session.resumeCurrent();
          },
          variant: 'default',
        },
      ]
    : [];
  const phase = calm ? 'calm' : state.phase;
  if (phase === 'calm')
    return (
      <StateFrame>
        <StateBlock
          title="A good place to stop"
          body="Nothing plays until you choose. Anything you saved waits in Keep."
          actions={[{ label: 'Find something new', onPress: discover, variant: 'primary' }, ...returnAction]}
        />
      </StateFrame>
    );
  if (phase === 'keep_blocked')
    return (
      <StateFrame>
        <StateBlock
          title="Your saved place needs attention"
          body="It changed or couldn't be checked, so nothing was applied. You can start from the top."
          actions={[
            { label: 'Start from the top', onPress: () => session.startKeepFromTop(), variant: 'primary' },
            {
              label: 'Return to Keep',
              href: '/saved',
              role: 'link',
              onPress: () => {
                if (session.leaveKeep()) router.navigate('/saved');
              },
              variant: 'default',
            },
          ]}
        />
      </StateFrame>
    );
  if (phase === 'offline')
    return (
      <StateFrame>
        <OfflineState body="Your place is kept. Try again when you're connected." onRetry={() => session.retry()} />
      </StateFrame>
    );
  if (phase === 'error')
    return (
      <StateFrame>
        <ErrorState title="Couldn't open that" body="Your place is kept." onRetry={() => session.retry()} />
      </StateFrame>
    );
  if (phase === 'pending')
    return (
      <StateFrame>
        <StateBlock
          title="Nothing new is ready yet"
          body="What you were watching stays right where it was. Check again when you like."
          actions={[{ label: 'Check again', onPress: discover, variant: 'primary' }, ...returnAction]}
        />
      </StateFrame>
    );
  if (phase === 'stale')
    return (
      <StateFrame>
        <StateBlock
          title="Your path changed"
          body={
            entry
              ? 'Refresh your directions, then choose your next move again.'
              : "That one isn't ready any more. Choose something new when you want."
          }
          actions={[
            {
              label: !entry
                ? 'Choose something new'
                : state.contextReady
                  ? 'Review your directions'
                  : 'Refresh directions',
              onPress: () => {
                if (!entry) discover();
                else if (state.contextReady) session.acknowledgeStale();
                else void session.refreshContext();
              },
              variant: 'primary',
            },
          ]}
        />
      </StateFrame>
    );
  if (phase === 'revoked')
    return (
      <StateFrame>
        <StateBlock
          title="This isn't available anymore"
          body="It may have been withdrawn, or your access changed. Your other saved places are unaffected."
          actions={[
            { label: 'Find something new', onPress: discover, variant: 'primary' },
            {
              label: 'Go to Keep',
              href: '/saved',
              role: 'link',
              onPress: () => router.navigate('/saved'),
              variant: 'default',
            },
          ]}
        />
      </StateFrame>
    );
  return (
    <StateFrame>
      <Skeleton rows={3} label="Opening your encounter" />
    </StateFrame>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper },
  scroll: { flexGrow: 1, paddingHorizontal: spacing[5] },
});
