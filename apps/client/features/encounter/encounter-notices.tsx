import { useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderStyle as borderStyleTokens, borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, PendingStripe, Text } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';
import type { EncounterSession, EncounterState } from './encounter-session';

interface Props {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
}

const FORMAT_WORD = { reel: 'Reel', scroll: 'Scroll' } as const;

/**
 * What a person asked for from this encounter (E06): a quiet chip while it is prepared, and a
 * ready notice that never interrupts and never switches anything by itself.
 */
function RequestNotice({ entry, session }: { readonly entry: EncounterEntry; readonly session: EncounterSession }) {
  const state = useSyncExternalStore(session.requests.subscribe, session.requests.getState, session.requests.getState);
  const [dismissed, setDismissed] = useState<string>();
  if (
    state.source?.exposureId !== entry.exposureId ||
    state.phase === 'draft' ||
    state.phase === 'ended' ||
    state.status?.status === 'cancelled'
  )
    return null;
  const what = state.mode === 'topic' ? 'request' : FORMAT_WORD[state.mode];
  if (state.status?.status === 'ready') {
    if (dismissed === state.receipt?.requestId) return null;
    return (
      <View role="status" style={styles.ready}>
        <View style={styles.readyBadge}>
          <Icon name="check" size={18} color={content.ink} />
        </View>
        <View style={styles.readyCopy}>
          <Text variant="uiS">
            Ready: your {what} of “{state.status.content.metadata.title}”.
          </Text>
          <View style={styles.row}>
            <Button label="Later" size="sm" onPress={() => setDismissed(state.receipt?.requestId)} />
            <Button
              label="Open"
              size="sm"
              variant="primary"
              onPress={() => {
                void session.openReadyRequest();
              }}
            />
          </View>
        </View>
      </View>
    );
  }
  if (state.status?.status === 'unavailable') return null;
  return (
    <View style={styles.chip}>
      <PendingStripe />
      <Text variant="uiS" style={styles.chipText}>
        {state.phase === 'accepted' || state.status?.status === 'preparing'
          ? `We'll let you know when the ${what} is ready`
          : 'Sending your request'}
      </Text>
      {state.phase === 'accepted' && state.status?.status === 'preparing' ? (
        <Button label="Cancel request" size="sm" variant="ghost" onPress={() => session.requests.cancel()} />
      ) : null}
    </View>
  );
}

/** Save, Like and place-keeping outcomes that need a person, in plain words. Quiet when all is well. */
function ActionNotices({ entry, state, session }: Props) {
  const removal = state.removal;
  const keep = state.keepPlace;
  return (
    <>
      {removal?.status === 'grace' ? (
        <Banner
          kind="info"
          lead="Removing from Keep."
          message="It goes in five seconds."
          action={{ label: 'Undo removal', onPress: () => session.undoRemoval() }}
        />
      ) : null}
      {removal?.status === 'preparing' || removal?.status === 'sending' ? (
        <Banner kind="reconnecting" lead="Removing from Keep." message="One moment." />
      ) : null}
      {removal?.status === 'unknown' ? (
        <Banner
          kind="error"
          lead="Removal wasn't confirmed."
          message="It may still be in Keep."
          action={{ label: 'Retry removal', onPress: () => session.retryRemoval() }}
        />
      ) : null}
      {removal?.status === 'unavailable' ? (
        <Banner kind="error" lead="Couldn't remove it." message="Check Keep before trying again." />
      ) : null}
      {state.actionFailed ? (
        <Banner
          kind="error"
          lead="That change wasn't confirmed."
          message="Your previous choice is shown."
          action={{ label: 'Retry change', onPress: () => session.retryAction() }}
        />
      ) : null}
      {keep?.write === 'unknown' ? (
        <Banner
          kind="error"
          lead="Your place wasn't saved."
          message={`It is still kept in this ${entry.kind === 'reel' ? 'Reel' : 'Scroll'}.`}
          action={{ label: 'Retry place update', onPress: () => session.retryKeep() }}
        />
      ) : null}
      {keep?.write === 'conflict' ? (
        <View style={styles.conflict}>
          <Banner kind="info" lead="Your saved place changed." message="Choose which place to keep." />
          <Button label="Use current saved place" size="sm" onPress={() => session.resolveKeepConflict('server')} />
          <Button
            label="Replace with my chosen place"
            size="sm"
            variant="ghost"
            onPress={() => session.resolveKeepConflict('candidate')}
          />
        </View>
      ) : null}
    </>
  );
}


/** Notices float above the tab bar, never over the actions or the title. */
export function EncounterNotices(props: Props) {
  return (
    <View style={styles.stack} pointerEvents="box-none">
      <RequestNotice entry={props.entry} session={props.session} />
      <ActionNotices {...props} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing[2] },
  row: { flexDirection: 'row', gap: spacing[2] },
  chip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: borderStyleTokens.preparing,
    overflow: 'hidden',
    backgroundColor: content.paper,
  },
  chipText: { flexShrink: 1 },
  ready: {
    flexDirection: 'row',
    gap: spacing[3],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  readyBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.fresh,
  },
  readyCopy: { flex: 1, gap: spacing[2] },
  conflict: { gap: spacing[2] },
});
