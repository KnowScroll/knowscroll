import { useRouter } from 'expo-router';
import { useAccountInitial } from '../../providers/account-scope';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  AccountButton,
  ActionStrip,
  Banner,
  Button,
  FormatSwitch,
  IconButton,
  Text,
  type FormatAvailability,
} from '@knowscroll/ui';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import type { EncounterState, EncounterSession } from './encounter-session';
import { RequestNotice, RequestPanel } from '../requests/request-panel';
import { EncounterOverlay } from './encounter-overlay';
import { ContinuationControls } from './continuation-controls';
import { KeepWriteStatus } from '../saved/keep-detail';

export function EncounterChrome({
  state,
  session,
  back,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly back: () => void;
}) {
  const router = useRouter();
  const initial = useAccountInitial();
  const entry = state.entry;
  if (!entry) return null;
  const availability: Record<'reel' | 'scroll', FormatAvailability> = { reel: 'unavailable', scroll: 'unavailable' };
  for (const variant of entry.context.variants)
    availability[variant.kind] = variant.status === 'ready' ? 'ready' : 'unavailable';
  const pending = entry.context.variants.find((variant) => variant.status === 'pending');
  return (
    <View>
      <View style={styles.top}>
        <IconButton icon="back" label="Back" onPress={back} />
        <View style={styles.center}>
          <FormatSwitch
            selected={entry.kind}
            availability={availability}
            onSelect={(to) => {
              if (entry.context.variants.some((variant) => variant.kind === to && variant.status === 'ready'))
                session.navigate({ mode: 'variant', to });
            }}
          />
          {entry.context.series ? <Text variant="meta">Part {entry.context.series.part}</Text> : null}
          {pending ? (
            <Text variant="meta">Your {pending.kind === 'reel' ? 'Reel' : 'Scroll'} request is still preparing.</Text>
          ) : null}
        </View>
        <AccountButton initial={initial} surface="light" href="/account" onPress={() => router.navigate('/account')} />
        <IconButton icon="more" label="More options" onPress={() => session.setOverlay(true)} />
      </View>
      <View style={styles.message}>
        <Button
          label="Keep this place"
          size="sm"
          variant="ghost"
          disabled={
            state.phase !== 'active' ||
            state.keepPlace?.write === 'sending' ||
            state.keepPlace?.write === 'unknown' ||
            state.keepPlace?.write === 'conflict'
          }
          onPress={() => {
            void session.keepThisPlace();
          }}
        />
        <KeepWriteStatus
          state={state.keepPlace}
          refresh={session.refreshKeep}
          retry={session.retryKeep}
          resolve={session.resolveKeepConflict}
        />
      </View>
    </View>
  );
}

export function EncounterActions({
  state,
  session,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
}) {
  const entry = state.entry;
  if (!entry) return null;
  return (
    <View>
      <ActionStrip
        available={['like', 'save', 'ask']}
        liked={entry.context.actions.liked}
        saved={entry.context.actions.saved}
        saving={state.actionPending}
        onAction={(action) => {
          if (action === 'ask') {
            session.openRequest();
            return;
          }
          if (state.actionPending || state.actionFailed) return;
          if (action === 'save') session.act(entry.context.actions.saved ? 'unsave' : 'save');
          if (action === 'like') session.act(entry.context.actions.liked ? 'unlike' : 'like');
        }}
      />
      <RequestNotice
        session={session.requests}
        exposureId={entry.exposureId}
        onPress={() => session.openRequest(session.requests.getState().mode)}
      />
      {state.removal?.status === 'grace' ? (
        <View style={styles.message}>
          <Text variant="bodyS">Removal starts in five seconds.</Text>
          <Button
            label="Undo removal"
            onPress={() => {
              session.undoRemoval();
            }}
          />
        </View>
      ) : null}
      {state.removal?.status === 'preparing' || state.removal?.status === 'sending' ? (
        <Text variant="meta">Checking your removal…</Text>
      ) : null}
      {state.removal?.status === 'unknown' ? (
        <View style={styles.message}>
          <Text variant="bodyS">Removal wasn't confirmed. Undo is no longer available.</Text>
          <Button
            label="Retry removal"
            onPress={() => {
              session.retryRemoval();
            }}
          />
        </View>
      ) : null}
      {state.removal?.status === 'unavailable' ? (
        <Text variant="bodyS">This removal couldn't be completed. Check Keep before choosing again.</Text>
      ) : null}
      {state.actionFailed ? (
        <View style={styles.message}>
          <Text variant="bodyS">That change wasn't confirmed. Your previous state is shown.</Text>
          <Button label="Retry change" size="sm" onPress={() => session.retryAction()} />
        </View>
      ) : null}
    </View>
  );
}

/** The menu is a local overlay, never an encounter/history member. Back and Esc close it first. */
export function EncounterMenu({
  state,
  session,
}: {
  readonly state: EncounterState;
  readonly session: EncounterSession;
}) {
  if (!state.overlay || !state.entry) return null;
  return (
    <EncounterOverlay
      label={state.overlayOwner === 'request' ? 'Ask for something' : 'Your path'}
      presentation={state.overlayOwner === 'request' ? 'sheet' : 'full'}
      onClose={() => {
        session.back();
      }}
    >
      {state.overlayOwner === 'request' ? (
        <RequestPanel session={session.requests} onClose={() => session.setOverlay(false)} />
      ) : (
        <View style={styles.overlay}>
          <ScrollView contentContainerStyle={styles.menu}>
            <View style={styles.top}>
              <Text variant="title" heading={2}>
                Your path
              </Text>
              <IconButton icon="close" label="Close" onPress={() => session.setOverlay(false)} />
            </View>
            <Text variant="meta">Visited · only your own path</Text>
            {state.trail.map((entry) => (
              <Button
                key={entry.exposureId}
                label={`${entry.kind === 'reel' ? 'Reel' : 'Scroll'} · ${entry.offer.metadata.title}`}
                variant="ghost"
                disabled={entry.exposureId === state.entry?.exposureId}
                onPress={() => session.restore(entry.exposureId)}
              />
            ))}
            <ContinuationControls entry={state.entry} session={session} />
            <Button
              label="Hide this encounter"
              variant="ghost"
              disabled={state.actionPending || state.actionFailed}
              onPress={() => {
                session.setOverlay(false);
                session.act('hide');
              }}
            />
            <Button label="Ask for something" onPress={() => session.openRequest()} />
            {(['reel', 'scroll'] as const)
              .filter(
                (format) =>
                  format !== state.entry?.kind &&
                  !state.entry?.context.variants.some(
                    (variant) => variant.kind === format && variant.status === 'ready',
                  ),
              )
              .map((format) => (
                <Button
                  key={format}
                  label={format === 'reel' ? 'Request Reel' : 'Request Scroll'}
                  onPress={() => session.openRequest(format)}
                />
              ))}
            <Banner kind="info" lead="Share isn't available yet." message="Requests stay private to your account." />
          </ScrollView>
        </View>
      )}
    </EncounterOverlay>
  );
}
const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
    backgroundColor: content.paper,
  },
  center: { flex: 1, gap: spacing[1], alignItems: 'center' },
  message: { gap: spacing[2], padding: spacing[3] },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: content.paper, zIndex: 10 },
  menu: { paddingTop: spacing[9], paddingHorizontal: layout.gutter, paddingBottom: spacing[24], gap: spacing[3] },
});
