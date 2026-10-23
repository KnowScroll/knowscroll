import { useEffect, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { scopeOutbox, type AccountScope } from '@knowscroll/client-core';
import { Button, Text } from '@knowscroll/ui';

/** P02 recording is independent of Clear, saved places and necessary explicit command receipts. */
export function RecordingControl({ scope }: { readonly scope: AccountScope }) {
  const policy = scope.recording;
  if (!policy)
    return (
      <Text variant="bodyS">
        Recording controls are unavailable. New exploration recording is paused on this device.
      </Text>
    );
  return <CurrentRecordingControl scope={scope} policy={policy} />;
}
function CurrentRecordingControl({
  scope,
  policy,
}: {
  scope: AccountScope;
  policy: NonNullable<AccountScope['recording']>;
}) {
  const state = useSyncExternalStore(policy.subscribe, policy.getState, policy.getState);
  useEffect(() => {
    void policy.refresh();
  }, [policy]);
  const busy = state.status === 'sending' || state.status === 'checking';
  const dropped = scopeOutbox(scope).status().dropped;
  return (
    <View style={{ gap: 16 }}>
      <Text variant="title" heading={2}>
        Personal recording
      </Text>
      <Text variant="body">
        Pause new watch and read history and the personal growth derived from it. You can keep exploring.
      </Text>
      <Text variant="bodyS">
        Actions you request, including Save and Remove, still keep the records needed to carry them out. Your existing
        history and saved places stay.
      </Text>
      <View accessibilityLiveRegion="polite">
        <Text variant="bodyS">
          {state.status === 'current'
            ? state.policy?.on
              ? 'Recording is on. After resuming, open a new encounter to start recording again.'
              : 'Recording is paused.'
            : state.status === 'sending'
              ? 'Sending your recording choice. New recording is paused on this device.'
              : state.status === 'checking'
                ? 'Checking recording status. New recording is paused on this device.'
                : 'Recording status could not be confirmed. New recording is paused on this device.'}
        </Text>
      </View>
      {state.status === 'current' && state.policy ? (
        <Button
          label={state.policy.on ? 'Pause recording' : 'Resume recording'}
          onPress={() => {
            void policy.set(!state.policy!.on);
          }}
        />
      ) : null}
      {state.retryOriginal ? (
        <>
          <Text variant="bodyS">
            Your earlier choice may already have arrived. Check it or retry that same choice before making another.
          </Text>
          <Button
            label="Retry the same recording choice"
            disabled={busy}
            onPress={() => {
              void policy.retryOriginal();
            }}
          />
          <Button
            label="Check recording choice"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              void policy.checkOriginal();
            }}
          />
        </>
      ) : null}
      <Button
        label="Check recording status"
        variant="ghost"
        disabled={busy}
        onPress={() => {
          void policy.refresh();
        }}
      />
      {dropped > 0 ? (
        <Text variant="bodyS">
          {dropped} {dropped === 1 ? 'group of unuploaded activity was' : 'groups of unuploaded activity were'}{' '}
          discarded because it could not be verified or kept on this device. Missing activity is not counted as reading
          or watching.
        </Text>
      ) : null}
    </View>
  );
}
