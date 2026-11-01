import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { PRIVACY_CLEAR_ACKNOWLEDGEMENT, type PrivacyClearState } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { Acknowledge, ConfirmBox, ReceiptCard, SettingsLabel, type ReceiptTone } from '../account/settings-parts';
import { clearProgress } from './clear-progress';
import { useAccountScope } from '../../providers/account-scope';

interface Receipt {
  readonly tone: ReceiptTone;
  readonly title: string;
  readonly text: string;
}

const REMOVED = [
  'Your watch and read history.',
  'Everything we worked out from it: your current interests and plans.',
  'Your universe: every system, planet and region.',
];
const STAYS = [
  'Keep items and their saved places.',
  'Your conversations, threads, rooms and messages.',
  'Your friends and sharing settings.',
];

/** What the removal is doing, as a receipt line; nothing before a request exists. */
function receiptFor(state: PrivacyClearState): Receipt | undefined {
  const underWay = clearProgress(state);
  if (underWay) return { tone: 'preparing', ...underWay };
  if (state.status === 'unknown')
    return {
      tone: 'failed',
      title: "We couldn't confirm your request",
      text: 'We could not confirm your request. It may already have been accepted.',
    };
  if (state.status === 'not_recorded')
    return state.retryOriginal
      ? {
          tone: 'failed',
          title: 'Not seen yet',
          text: 'No receipt appeared in this check. Your original request may still arrive.',
        }
      : undefined;
  if (state.status === 'completed_live')
    return {
      tone: 'done',
      title: 'Cleared from KnowScroll',
      text: 'Live exploration removal is complete. Your universe and history are gone from the app and our live systems.',
    };
  if (state.status === 'failed')
    return {
      tone: 'failed',
      title: 'Removal not verified',
      text: 'Live removal could not be verified. Check its status again; your request is retained.',
    };
  if (state.status === 'unavailable')
    return {
      tone: 'failed',
      title: "Can't check",
      text: 'We could not check removal status. No completion is confirmed.',
    };
  return undefined;
}

/** The plain line shown when nothing has been requested; also what a screen reader hears first. */
function plainMessage(state: PrivacyClearState): string | undefined {
  return state.status === 'not_recorded' && !state.retryOriginal
    ? 'No clear request is recorded for this account.'
    : undefined;
}

/**
 * P02 "Clear exploration": what is removed and what stays before one deliberate step, then honest
 * receipt states over the manager-owned controller (selective Clear, #345). Used on its own page
 * on phones (the page title names it: `titled={false}`) and as a card on desktops.
 */
export function ClearPanel({
  titled = true,
  compact = false,
}: {
  readonly titled?: boolean;
  /** The desktop card draws its words one size smaller (D05). */
  readonly compact?: boolean;
}) {
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
  const receipt = receiptFor(state);
  const plain = plainMessage(state);
  const lineVariant = compact ? 'meta' : 'bodyS';
  return (
    <View style={{ gap: spacing[3] }}>
      {titled ? (
        <Text variant="title" heading={2}>
          Clear exploration
        </Text>
      ) : null}
      <SettingsLabel>What's removed</SettingsLabel>
      {REMOVED.map((line) => (
        <Text key={line} variant={lineVariant}>
          {line}
        </Text>
      ))}
      <SettingsLabel>What stays</SettingsLabel>
      {STAYS.map((line) => (
        <Text key={line} variant={lineVariant}>
          {line}
        </Text>
      ))}
      <Text variant="meta" color={content.ink2}>
        Friends who visit will see an empty universe. A new one grows from what you explore next. This cannot be undone.
      </Text>
      <Text variant="meta" color={content.ink2}>
        Context already sent to an AI provider cannot be recalled. Live removal does not confirm expiry of backups,
        provider copies or copies on offline devices. No expiry date is confirmed here.
      </Text>
      {receipt ? (
        <View accessibilityLiveRegion="polite">
          <ReceiptCard tone={receipt.tone} state={receipt.title}>
            <Text variant="meta">{receipt.text}</Text>
            {state.receipt ? (
              <Text variant="meta" color={content.ink2}>
                Clear request recorded {new Date(state.receipt.recordedAt).toLocaleString()}
              </Text>
            ) : null}
            {state.status === 'completed_live' ? (
              <Text variant="meta" color={content.ink2}>
                Backups: copies expire on their own and are not used to rebuild anything. Keep and conversations are
                untouched.
              </Text>
            ) : null}
          </ReceiptCard>
        </View>
      ) : plain ? (
        <View accessibilityLiveRegion="polite">
          <Text variant="meta" color={content.ink2}>
            {plain}
          </Text>
        </View>
      ) : null}
      {state.retryOriginal ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="Retry the same clear request"
            size="sm"
            disabled={busy || account.status !== 'signed_in'}
            onPress={() => {
              void privacy.retryOriginal();
            }}
          />
        </View>
      ) : null}
      {account.status === 'signed_in' ? (
        <View style={{ alignItems: 'flex-start' }}>
          <Button
            label="Check removal status"
            size="sm"
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
        <ConfirmBox>
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
        </ConfirmBox>
      ) : null}
    </View>
  );
}
