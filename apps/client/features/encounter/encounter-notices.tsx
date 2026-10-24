import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderStyle as borderStyleTokens, borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, PendingStripe, Text } from '@knowscroll/ui';
import { useDevicePreferences } from '../../providers/device-preferences';
import { unavailableCopy } from '../requests/request-copy';
import { RemovalNotice } from '../saved/removal-notice';
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
  const { preferences } = useDevicePreferences();
  if (
    state.source?.exposureId !== entry.exposureId ||
    state.phase === 'draft' ||
    state.phase === 'ended' ||
    state.status?.status === 'cancelled'
  )
    return null;
  const what = state.mode === 'topic' ? 'request' : FORMAT_WORD[state.mode];
  const dismissed = state.receipt !== undefined && state.dismissedRequestId === state.receipt.requestId;
  if (state.status?.status === 'ready') {
    // Notifications > Ready requests: off, the notice stays away; the request is still in Keep.
    if (dismissed || !preferences.readyNotices) return null;
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
            <Button label="Later" size="sm" onPress={() => session.requests.dismissNotice()} />
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
  if (state.status?.status === 'unavailable') {
    if (dismissed) return null;
    return (
      <View role="status" style={styles.unavailable}>
        <Text variant="uiS" style={styles.chipText}>
          {unavailableCopy[state.status.reason]}
        </Text>
        <Button label="Dismiss" size="sm" variant="ghost" onPress={() => session.requests.dismissNotice()} />
      </View>
    );
  }
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

/**
 * E07: the Reel or Scroll the person asked for, once it is open ("Ready — the Scroll you asked
 * for"). It stays with that encounter only and never switches anything by itself.
 */
function AskedForNotice({ entry, state }: Pick<Props, 'entry' | 'state'>) {
  const askedFor = state.askedFor;
  if (askedFor === undefined || askedFor.assetId !== entry.offer.assetId) return null;
  return (
    <View role="status" style={styles.askedFor} testID="encounter-asked-for">
      <Icon name="check" size={18} color={content.ink} />
      <Text variant="uiS">Ready — the {FORMAT_WORD[askedFor.kind]} you asked for</Text>
    </View>
  );
}

/** Save, Like and place-keeping outcomes that need a person, in plain words. Quiet when all is well. */
function ActionNotices({ entry, state, session }: Props) {
  const removal = state.removal;
  const keep = state.keepPlace;
  return (
    <>
      <RemovalNotice removal={removal} undo={() => session.undoRemoval()} retry={() => session.retryRemoval()} />
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
      <AskedForNotice entry={props.entry} state={props.state} />
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
  unavailable: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  askedFor: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.fresh,
  },
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
