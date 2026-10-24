import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { content } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ReceiptCard } from './settings-parts';

/** How often a device asks how its deletion is going while it is still being removed. */
const POLL_MS = 15_000;

const BACKUPS = 'Backup copies are not used to rebuild anything and expire on their own schedule.';

/**
 * The receipt of this device's account deletion (P02 "Receipts · clear & delete"). Deletion ends
 * every session, so this is shown where a signed-out person lands, and it is read without one. It
 * says what is true: removing, could not finish (with Retry), or gone from our live systems, with
 * backups named as a separate line, never as a date it cannot know. Renders nothing when this
 * device asked for no deletion.
 */
export function DeletionReceiptPanel() {
  const { manager } = useAccountScope();
  const receipt = manager.deletion;
  const state = useSyncExternalStore(receipt.subscribe, receipt.getState, receipt.getState);
  useEffect(() => {
    if (state.status === 'unchecked') void receipt.refresh();
    if (state.status !== 'in_progress') return undefined;
    const timer = setInterval(() => void receipt.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [receipt, state.status]);
  if (state.status === 'none') return null;
  if (state.status === 'unchecked' || state.status === 'checking')
    return (
      <ReceiptCard tone="preparing" state="Checking your deletion">
        <Text variant="meta" color={content.ink2}>
          Asking whether your account has been removed.
        </Text>
      </ReceiptCard>
    );
  if (state.status === 'unavailable')
    return (
      <ReceiptCard tone="preparing" state="Can't check right now">
        <Text variant="meta" color={content.ink2}>
          Your deletion request is not affected. Check again when you are back online.
        </Text>
        <Button label="Check again" size="sm" onPress={() => void receipt.refresh()} />
      </ReceiptCard>
    );
  if (state.status === 'needs_retry')
    return (
      <ReceiptCard tone="failed" state="We couldn't finish removing">
        <Text variant="meta" color={content.ink2}>
          Nothing has been reported as cleared yet. Retrying continues the same request.
        </Text>
        <View>
          <Button label="Retry" size="sm" variant="danger" onPress={() => void receipt.retry()} />
        </View>
      </ReceiptCard>
    );
  if (state.status === 'completed')
    return (
      <ReceiptCard tone="done" state="Account deleted">
        <Text variant="meta" color={content.ink2}>
          Your account and its history are gone from KnowScroll's live systems. {BACKUPS}
        </Text>
        <View>
          <Button label="Done" size="sm" onPress={() => receipt.forget()} />
        </View>
      </ReceiptCard>
    );
  return (
    <ReceiptCard tone="preparing" state="Deletion in progress">
      <Text variant="meta" color={content.ink2}>
        You're signed out everywhere. We're removing your account from our live systems. {BACKUPS}
      </Text>
    </ReceiptCard>
  );
}
