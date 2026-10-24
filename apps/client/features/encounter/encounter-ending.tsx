import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, View, findNodeHandle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Tag, Text } from '@knowscroll/ui';
import { RemovalNotice } from '../saved/removal-notice';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';
import { useEncounterMetrics } from './encounter-metrics';

/** The card's heading takes focus when the card arrives, so a keyboard or screen-reader user starts on it (E08). */
function CardHeading({ children }: { readonly children: ReactNode }) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    if (Platform.OS === 'web') (node as unknown as { focus?: () => void }).focus?.();
    else {
      const tag = findNodeHandle(node);
      if (typeof tag === 'number') AccessibilityInfo.setAccessibilityFocus(tag);
    }
  }, []);
  return (
    <View ref={ref} accessible focusable tabIndex={-1}>
      <Text variant="displayL" heading={1}>
        {children}
      </Text>
    </View>
  );
}

/** The visited steps of the thread, newest last, as plain rows (no counts, no grades). */
function visitedRows(state: EncounterState): readonly EncounterEntry[] {
  return state.trail.slice(-5);
}

function ThreadRow({ entry }: { readonly entry: EncounterEntry }) {
  const relation = entry.offer.relation;
  const label =
    relation.kind === 'series_step' ? `Part ${String(relation.part)}` : entry.kind === 'reel' ? 'Reel' : 'Scroll';
  return (
    <View style={styles.thread}>
      <Tag label={label} variant={relation.kind === 'series_step' ? 'part' : 'neutral'} />
      <Text variant="ui" style={styles.threadTitle}>
        {entry.offer.metadata.title}
      </Text>
    </View>
  );
}

/**
 * E07: a move the feed could not make (nothing more is ready on this) is not the end of a thread. It
 * says so plainly and offers real next steps, on paper rather than the ending's yellow.
 */
function NothingMoreReady({
  state,
  session,
  onDone,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const metrics = useEncounterMetrics();
  return (
    <View testID="encounter-nothing-more" style={[styles.ground, styles.paperGround]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing[8], paddingBottom: metrics.bottom + spacing[6] },
        ]}
      >
        <View style={styles.plain}>
          <CardHeading>You&apos;ve seen what&apos;s ready for now</CardHeading>
          <Text variant="body">More may come later. Here are a few ways to keep going.</Text>
          <RemovalNotice
            removal={state.removal}
            undo={() => session.undoRemoval()}
            retry={() => session.retryRemoval()}
          />
          <View style={styles.actions}>
            <Button
              label="Another subject"
              icon="arrowUp"
              variant="primary"
              onPress={() => session.chooseDirection()}
            />
            <Button
              label="Something you kept"
              icon="save"
              role="link"
              href="/saved"
              onPress={() => router.navigate('/saved')}
            />
            <Button label="Done for now" variant="ghost" onPress={onDone} />
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * E08: a satisfying stop is a designed state. The way back is kept only when the person asks,
 * "Something different" opens a fresh subject, and "Done for now" leaves a calm Explore with no
 * autoplay. No streaks, counts or "you learned" wording.
 */
export function EncounterEnding({
  entry,
  state,
  session,
  onDone,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly onDone: () => void;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const metrics = useEncounterMetrics();
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    // Escape is Done for now (E08).
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onDone]);
  const removalNotice = (
    <RemovalNotice removal={state.removal} undo={() => session.undoRemoval()} retry={() => session.retryRemoval()} />
  );
  const saved = entry.context.actions.saved;
  const kept = asked && saved;
  const series = entry.context.series;
  if (state.outcome?.status === 'exhausted' && series === undefined)
    return <NothingMoreReady state={state} session={session} onDone={onDone} />;
  return (
    <View testID="encounter-ending" style={styles.ground}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing[8], paddingBottom: metrics.bottom + spacing[6] },
        ]}
      >
        <View style={styles.card}>
          {kept ? (
            <>
              <View style={styles.check}>
                <Icon name="check" size={28} />
              </View>
              <CardHeading>We'll bring you back here</CardHeading>
              <Text variant="body">
                {series ? `Part ${String(series.part)}, end — ` : ''}“{entry.offer.metadata.title}”.
              </Text>
              <Text variant="bodyS" color={content.ink2}>
                It's in Keep whenever you want it. Next time you open Explore you'll get something new; this thread
                waits until you choose it. Nothing expires.
              </Text>
              {removalNotice}
              <View style={styles.actions}>
                <Button label="See it in Keep" role="link" href="/saved" onPress={() => router.navigate('/saved')} />
                <Button label="Undo" onPress={() => session.act('unsave')} />
              </View>
            </>
          ) : (
            <>
              <Text variant="label" color={content.ink2}>
                {series ? 'End of thread' : 'A good place to stop'}
              </Text>
              <CardHeading>A good place to pause</CardHeading>
              <View style={styles.list}>
                {visitedRows(state).map((visited) => (
                  <ThreadRow key={visited.exposureId} entry={visited} />
                ))}
              </View>
              {state.actionFailed ? (
                <Banner
                  kind="error"
                  lead="Couldn't keep a way back."
                  message="Nothing was saved."
                  action={{ label: 'Try again', onPress: () => session.retryAction() }}
                />
              ) : null}
              {removalNotice}
              <View style={styles.actions}>
                <Button
                  label={saved ? 'Saved in Keep' : 'Keep a way back'}
                  icon="save"
                  variant="primary"
                  disabled={saved || state.actionPending === true}
                  busy={state.actionPending === true}
                  onPress={() => {
                    setAsked(true);
                    session.act('save');
                  }}
                />
                <Button label="Something different" icon="arrowUp" onPress={() => session.chooseDirection()} />
                <Button label="Done for now" variant="ghost" onPress={onDone} />
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.continue },
  paperGround: { backgroundColor: content.paper },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing[5] },
  card: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    gap: spacing[4],
    padding: spacing[5],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.heroInk,
  },
  plain: { width: '100%', maxWidth: 480, alignSelf: 'center', gap: spacing[4] },
  list: { gap: spacing[3] },
  thread: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  threadTitle: { flex: 1 },
  actions: { gap: spacing[3] },
  check: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.fresh,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
});
