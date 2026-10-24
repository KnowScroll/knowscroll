import { useEffect, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { scopeOutbox, type AccountScope } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, SwitchRow, Text } from '@knowscroll/ui';
import { SettingsLabel } from '../account/settings-parts';

const STAYS_THE_SAME = [
  'Your existing systems and planets stay exactly as they are.',
  'Things you Save are kept, with your place in them. Save and Remove still keep the records they need.',
  'Requests you make still get prepared.',
];
const CHANGES = ['No new worlds or regions form from this time.', 'The feed only follows what you ask for right now.'];

/**
 * P02 recording as a switch: on, what you actually watch or read can grow your worlds; off, new
 * viewing is not recorded. Independent of Clear, saved places and the records an explicit command
 * needs. The switch and its Resume button send the same commands; the page never claims a state it
 * has not read back.
 */
export function RecordingControl({ scope }: { readonly scope: AccountScope }) {
  const policy = scope.recording;
  if (!policy)
    return <Text variant="bodyS">Recording controls are unavailable. New recording is paused on this device.</Text>;
  return <CurrentRecordingControl scope={scope} policy={policy} />;
}

function PausedCard({ onResume, disabled }: { readonly onResume: () => void; readonly disabled: boolean }) {
  return (
    <View style={styles.paused}>
      <View style={styles.pausedHead}>
        <Icon name="pause" size={20} color={content.paper} />
        <Text variant="bodyS" color={content.paper} style={styles.pausedTitle}>
          Recording paused
        </Text>
      </View>
      <Text variant="meta" color={content.paper}>
        While paused, what you watch won't shape your universe. Save, Share and Talk still work. Nothing is filled in
        later.
      </Text>
      <View style={styles.pausedAction}>
        <Button label="Resume recording" size="sm" disabled={disabled} onPress={onResume} />
      </View>
    </View>
  );
}

function BulletList({ title, lines }: { readonly title: string; readonly lines: readonly string[] }) {
  return (
    <>
      <SettingsLabel>{title}</SettingsLabel>
      {lines.map((line) => (
        <Text key={line} variant="bodyS">
          {line}
        </Text>
      ))}
    </>
  );
}

function statusLine(status: 'checking' | 'sending' | 'unknown' | 'ended'): string {
  if (status === 'sending') return 'Sending your choice. New recording is paused on this device.';
  if (status === 'checking') return 'Checking recording status. New recording is paused on this device.';
  return "We couldn't confirm your recording status. New recording is paused on this device.";
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
  const known = state.status === 'current' && state.policy !== undefined;
  const recording = known && state.policy?.on === true;
  const paused = known && state.policy?.on === false;
  const resumedHere = recording && state.receipt?.on === true;
  return (
    <View style={styles.block}>
      <SwitchRow
        label="Shape my universe from what I watch"
        description={
          paused
            ? 'Off: new viewing is not added to your universe.'
            : 'On: Reels and Scrolls you actually watch or read can grow your worlds.'
        }
        on={recording}
        disabled={!known}
        onChange={(next) => {
          void policy.set(next);
        }}
      />
      {!known ? (
        <View accessibilityLiveRegion="polite">
          <Text variant="meta" color={content.ink2}>
            {statusLine(state.status === 'current' ? 'unknown' : state.status)}
          </Text>
        </View>
      ) : null}
      {resumedHere ? (
        <View accessibilityLiveRegion="polite">
          <Text variant="meta" color={content.ink2}>
            Recording is on. Open a new encounter to start recording again.
          </Text>
        </View>
      ) : null}
      {paused ? (
        <>
          <PausedCard
            disabled={busy}
            onResume={() => {
              void policy.set(true);
            }}
          />
          <BulletList title="What stays the same" lines={STAYS_THE_SAME} />
          <BulletList title="What changes" lines={CHANGES} />
        </>
      ) : null}
      {state.retryOriginal ? (
        <>
          <Text variant="meta" color={content.ink2}>
            Your earlier choice may already have arrived. Check it or retry that same choice before making another.
          </Text>
          <View style={styles.actions}>
            <Button
              label="Retry the same recording choice"
              size="sm"
              disabled={busy}
              onPress={() => {
                void policy.retryOriginal();
              }}
            />
            <Button
              label="Check recording choice"
              size="sm"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                void policy.checkOriginal();
              }}
            />
          </View>
        </>
      ) : null}
      {!known ? (
        <View style={styles.actions}>
          <Button
            label="Check recording status"
            size="sm"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              void policy.refresh();
            }}
          />
        </View>
      ) : null}
      {dropped > 0 ? (
        <Text variant="meta" color={content.ink2}>
          {dropped} {dropped === 1 ? 'group of unuploaded activity was' : 'groups of unuploaded activity were'}{' '}
          discarded because it could not be verified or kept on this device. Missing activity is not counted as reading
          or watching.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing[3] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  paused: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.ink,
  },
  pausedHead: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  pausedTitle: { fontWeight: '700' },
  pausedAction: { alignItems: 'flex-start', paddingTop: spacing[1] },
});
