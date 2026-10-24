import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { requestAccountDeletion, type AccountDeletionOutcome } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import { Acknowledge, SettingsLabel } from '../account/settings-parts';

const removed = [
  'Your account and email address.',
  'Your watch and read history and your universe.',
  'Your Keep items and the places you saved in them.',
  'Your requests, exports, devices and sharing settings.',
  'Your friendships and invitations.',
];
const stays = [
  'Reels and Scrolls KnowScroll made, which anyone can read.',
  'What other people wrote and kept. They see "Deleted account" where you were.',
  'Reports other people sent about you or your messages stay for 90 days, no longer linked to your account. Reports you sent are removed.',
];

/**
 * P02 "Delete account": the consequences, then one deliberate step. The answer ends every session,
 * so the result is read from the receipt, which needs none. A request that gets no answer is not
 * assumed either way: "Check" asks the receipt whether it arrived.
 */
export function DeletePanel({ titled = true }: { readonly titled?: boolean }) {
  const router = useRouter();
  const { manager, state: account } = useAccountScope();
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Exclude<AccountDeletionOutcome, 'accepted'> | 'not_received' | undefined>(
    undefined,
  );
  const scope = account.status === 'signed_in' && account.scope.active ? account.scope : undefined;
  const leave = () => router.replace('/account');

  const send = async () => {
    if (scope === undefined || !understood) return;
    setBusy(true);
    setOutcome(undefined);
    const result = await requestAccountDeletion(scope, {
      newId: newCommandId,
      remember: manager.deletion.remember,
      forget: manager.deletion.forget,
      ended: manager.endAfterAccountDeletion,
    });
    setBusy(false);
    if (result === 'accepted') leave();
    else setOutcome(result);
  };

  const check = async () => {
    setBusy(true);
    await manager.deletion.refresh();
    setBusy(false);
    const known = manager.deletion.getState().status;
    if (known === 'none') setOutcome('not_received');
    else if (known === 'in_progress' || known === 'needs_retry' || known === 'completed') {
      await manager.endAfterAccountDeletion();
      leave();
    }
  };

  return (
    <View style={{ gap: spacing[4] }}>
      {titled ? (
        <Text variant="title" heading={2}>
          Delete account
        </Text>
      ) : null}
      <Text variant="body">
        Removes your account, history, universe, kept items and messages you sent. People you messaged keep a "deleted
        account" placeholder.
      </Text>
      <SettingsLabel>What's removed</SettingsLabel>
      {removed.map((line) => (
        <Text key={line} variant="bodyS">
          {line}
        </Text>
      ))}
      <SettingsLabel>What stays</SettingsLabel>
      {stays.map((line) => (
        <Text key={line} variant="bodyS">
          {line}
        </Text>
      ))}
      <Text variant="bodyS" color={content.ink2}>
        This cannot be undone, and you are signed out on every device at once. Context already sent to an AI provider
        cannot be recalled. Backup copies are not used to rebuild anything and expire on their own schedule.
      </Text>
      {outcome === 'stale' ? (
        <Banner kind="error" lead="This page was out of date." message="Reload it and try again." />
      ) : null}
      {outcome === 'unavailable' ? (
        <Banner
          kind="error"
          lead="Deletion can't start right now."
          message="If a clear is still finishing, try again in a moment."
        />
      ) : null}
      {outcome === 'not_received' ? (
        <Banner kind="info" lead="Your request did not arrive." message="Nothing was deleted. You can try again." />
      ) : null}
      {outcome === 'unconfirmed' ? (
        <Banner
          kind="error"
          lead="We couldn't confirm your request."
          message="It may have arrived. Check before you try again."
          action={{ label: 'Check', onPress: () => void check() }}
        />
      ) : null}
      {scope === undefined ? (
        <Text variant="bodyS">Sign in to delete your account.</Text>
      ) : (
        <View style={{ gap: spacing[4], alignItems: 'flex-start' }}>
          <Acknowledge label="I understand this cannot be undone" checked={understood} onChange={setUnderstood} />
          <Button
            label="Delete account"
            busyLabel="Deleting…"
            variant="danger"
            busy={busy}
            disabled={!understood}
            onPress={() => void send()}
          />
        </View>
      )}
    </View>
  );
}
