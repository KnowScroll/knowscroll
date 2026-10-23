import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { PRIVACY_CLEAR_ACKNOWLEDGEMENT, type PrivacyClearState } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { newCommandId } from '../../platform/command-id';
import { ScreenFrame } from '../shell/screen-frame';
import { RecordingControl } from './recording-control';

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

/** P02: explicit selective clear and honest receipt states over the manager-owned controller. */
export function PrivacyScreen() {
  const { manager, state: account } = useAccountScope();
  const privacy = manager.privacy;
  const state = useSyncExternalStore(privacy.subscribe, privacy.getState, privacy.getState);
  const router = useRouter();
  const [understood, setUnderstood] = useState(false);
  const scope = account.status === 'signed_in' ? account.scope : undefined;
  useEffect(() => {
    if (scope) void privacy.refreshStatus();
  }, [scope, privacy]);
  const busy = state.status === 'sending' || state.status === 'checking';
  const canConfirm = account.status === 'signed_in' && account.scope.active && state.canConfirm;
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/account');
  };
  return (
    <ScreenFrame
      tone="paper"
      title="Privacy & history"
      showAccount={false}
      leading={<IconButton icon="back" label="Back to account" onPress={back} />}
    >
      <View style={styles.body}>
        {scope ? <RecordingControl scope={scope} /> : null}
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
          <Button
            label="Check removal status"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              void privacy.refreshStatus();
            }}
          />
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
          <View style={styles.confirm}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel="I understand this cannot be undone"
              accessibilityState={{ checked: understood }}
              onPress={() => setUnderstood((value) => !value)}
            >
              <Text variant="bodyS">{understood ? '✓ ' : '□ '}I understand this cannot be undone.</Text>
            </Pressable>
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
        <Text variant="meta" color={content.ink2}>
          History export and account deletion are not available from this page yet.
        </Text>
      </View>
    </ScreenFrame>
  );
}
const styles = StyleSheet.create({
  body: { gap: spacing[4], paddingTop: spacing[6], paddingBottom: spacing[8] },
  confirm: { gap: spacing[4], alignItems: 'flex-start' },
});
