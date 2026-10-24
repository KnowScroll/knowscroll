import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { PRIVACY_CLEAR_ACKNOWLEDGEMENT, type PrivacyClearState } from '@knowscroll/client-core';
import { spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { Acknowledge } from '../account/settings-parts';
import { useAccountScope } from '../../providers/account-scope';

const message = (state: PrivacyClearState): string => {
  if (state.status === 'sending') return 'Sending your clear request…';
  if (state.status === 'checking') return 'Checking the latest removal status…';
  if (state.status === 'accepted') return 'Your clear request was accepted. Live removal has not been confirmed yet.';
  if (state.status === 'unknown') return 'We could not confirm your request. It may already have been accepted.';
  if (state.status === 'not_recorded')
    return state.retryOriginal
      ? 'No receipt appeared in this check. Your original request may still arrive.'
      : 'No clear request is recorded for this account.';
  if (state.status === 'completed_live') return 'Live exploration removal is complete.';
  if (state.status === 'failed')
    return 'Live removal could not be verified. Check its status again; your request is retained.';
  if (state.status === 'pending') {
    if (state.phase === 'waiting_for_accounting')
      return 'Some earlier activity is still finishing. Your removal request is retained.';
    if (state.phase === 'verifying_live_removal') return 'Checking that live exploration data has been removed.';
    return 'Your exploration history and universe are being removed.';
  }
  if (state.status === 'unavailable') return 'We could not check removal status. No completion is confirmed.';
  return '';
};

/**
 * P02 "Clear exploration": what is removed and what stays before one deliberate step, then honest
 * receipt states over the manager-owned controller (selective Clear, #345). Used on its own page
 * on phones and as a card on desktops.
 */
export function ClearPanel() {
  const { manager, state: account } = useAccountScope();
  const privacy = manager.privacy;
  const state = useSyncExternalStore(privacy.subscribe, privacy.getState, privacy.getState);
  const [understood, setUnderstood] = useState(false);
  const scope = account.status === 'signed_in' ? account.scope : undefined;
  useEffect(() => {
    if (scope) void privacy.refreshStatus();
  }, [scope, privacy]);
  const busy = state.status === 'sending' || state.status === 'checking';
  const canConfirm = account.status === 'signed_in' && account.scope.active && state.canConfirm;
  return (
    <View style={{ gap: spacing[4] }}>
      <Text variant="title" heading={2}>
        Clear exploration
      </Text>
      <Text variant="body">
        Removes your watch and read history, the interests and plans derived from it, and your universe.
      </Text>
      <Text variant="body">
        Keep items and their saved places stay. Your friends, sharing settings, conversations, threads, rooms and
        messages stay.
      </Text>
      <Text variant="bodyS">This cannot be undone. A new universe can grow from what you explore next.</Text>
      <Text variant="bodyS">
        Context already sent to an AI provider cannot be recalled. Live removal does not confirm expiry of backups,
        provider copies or copies on offline devices. No expiry date is confirmed here.
      </Text>
      {message(state) ? (
        <View accessibilityLiveRegion="polite">
          <Text variant="bodyS">{message(state)}</Text>
        </View>
      ) : null}
      {state.receipt ? (
        <Text variant="meta">Clear request recorded {new Date(state.receipt.recordedAt).toLocaleString()}</Text>
      ) : null}
      {state.retryOriginal ? (
        <Button
          label="Retry the same clear request"
          disabled={busy || account.status !== 'signed_in'}
          onPress={() => {
            void privacy.retryOriginal();
          }}
        />
      ) : null}
      {account.status === 'signed_in' ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="Check removal status"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              void privacy.refreshStatus();
            }}
          />
        </View>
      ) : account.status === 'unavailable' ? (
        <Button
          label="Reconnect to your account"
          onPress={() => {
            void manager.refresh();
          }}
        />
      ) : (
        <Text variant="bodyS">Sign in to manage your exploration history.</Text>
      )}
      {canConfirm ? (
        <View style={{ gap: spacing[4], alignItems: 'flex-start' }}>
          <Acknowledge label="I understand this cannot be undone" checked={understood} onChange={setUnderstood} />
          <Button
            label="Clear exploration"
            variant="danger"
            disabled={!understood}
            onPress={() => {
              if (!understood) return;
              setUnderstood(false);
              void privacy.confirm({ commandId: newCommandId(), confirmation: PRIVACY_CLEAR_ACKNOWLEDGEMENT });
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
