import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import type { AccountScope, PresencePreference, VisibilitySave } from '@knowscroll/client-core';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Text } from '@knowscroll/ui';
import { RadioRow, SegmentedChoice, SwitchRow } from './choice-rows';
import { useVisibilitySession } from './use-visibility-session';

const PRESENCE_CHOICES: readonly { value: PresencePreference; label: string; description: string }[] = [
  { value: 'online', label: 'Online', description: 'Friends see “Online” while you have the app open.' },
  { value: 'recently_active', label: 'Recently active', description: 'Friends see only that you were around lately.' },
  { value: 'hidden', label: 'Don’t show', description: 'Friends see nothing about whether you are around.' },
];

function SaveNote({ save, onRetry }: { readonly save: VisibilitySave; readonly onRetry: () => void }) {
  if (save.status === 'idle') return null;
  if (save.status === 'saving')
    return (
      <View role="status">
        <Text variant="meta" color={content.ink2}>
          Saving…
        </Text>
      </View>
    );
  if (save.status === 'saved')
    return (
      <View role="status">
        <Text variant="meta" color={content.ink2}>
          Saved. This applies from now on.
        </Text>
      </View>
    );
  return (
    <View style={styles.failed} role="alert">
      <Banner
        kind="error"
        lead="Couldn’t save."
        message={
          save.reason === 'stale'
            ? 'These settings changed somewhere else. What you see now is current.'
            : save.reason === 'offline'
              ? 'Check your connection. Nothing was changed.'
              : 'Nothing was changed.'
        }
      />
      <Button label="Retry" size="sm" variant="ghost" onPress={onRetry} />
    </View>
  );
}

/**
 * F02 "Sharing & visibility" (P02, D-047): who may visit the person's universe, which systems they see,
 * whether friends see "Online" or "Recently active", and whether the people they talk with see SEEN (D-066).
 * Everything about visits starts off: nobody may visit, no system is shared and availability is hidden. SEEN
 * starts on. A change applies to every later read at once; what a
 * friend already saw cannot be taken back, and the page says so. It never shows what anyone watched.
 */
export function VisibilityPanel({
  scope,
  titled = true,
}: {
  readonly scope: AccountScope;
  /** Draws the heading; a page that names itself passes false. */
  readonly titled?: boolean;
}) {
  const { session, state } = useVisibilitySession(scope);
  useEffect(() => {
    void session.load();
  }, [session]);
  const { draft, confirmed, presence, readReceipts } = state;
  const busy = state.save.status === 'saving';
  return (
    <View style={styles.panel}>
      {titled ? (
        <Text variant="title" heading={2}>
          Sharing & visibility
        </Text>
      ) : null}
      {state.load === 'loading' ? <Skeleton rows={3} label="Loading your sharing settings" /> : null}
      {state.load === 'unavailable' ? (
        <>
          <Banner kind="offline" lead="Couldn’t load your settings." message="Nothing is shared until you choose." />
          <Button label="Try again" size="sm" variant="ghost" onPress={() => void session.load()} />
        </>
      ) : null}
      {draft && confirmed ? (
        <>
          <Text variant="bodyS">
            Friends can visit your universe only if you let them. They see the names of the systems you share and the
            planets in them, and nothing about what you read or watch.
          </Text>
          <View role="radiogroup" accessibilityLabel="Who can visit your universe" style={styles.group}>
            <Text variant="label" color={content.ink2} heading={3}>
              Visitors
            </Text>
            <RadioRow
              testID="visitors-nobody"
              label="Nobody"
              description="No one can visit. This is how every universe starts."
              checked={draft.mode === 'nobody'}
              onPress={() => void session.setAudience('nobody')}
            />
            <RadioRow
              testID="visitors-chosen"
              label="Friends I choose"
              checked={draft.mode === 'chosen_friends'}
              onPress={() => void session.setAudience('chosen_friends')}
            >
              {draft.mode === 'chosen_friends' ? (
                <View style={styles.indent}>
                  {state.friends.status === 'loading' ? <Skeleton rows={1} label="Loading your friends" /> : null}
                  {state.friends.status === 'failed' ? (
                    <Text variant="meta" color={content.ink2}>
                      Your friends couldn’t be listed. Try again in a moment.
                    </Text>
                  ) : null}
                  {state.friends.status === 'ready' && state.friends.items.length === 0 ? (
                    <Text variant="meta" color={content.ink2}>
                      You have no friends to choose yet.
                    </Text>
                  ) : null}
                  {state.friends.items.map((person) => (
                    <SwitchRow
                      key={person.personId}
                      testID={`visitor-${person.personId}`}
                      label={person.displayName}
                      description={`@${person.handle}`}
                      checked={draft.friendIds.includes(person.personId)}
                      onPress={() => void session.toggleFriend(person.personId)}
                    />
                  ))}
                </View>
              ) : null}
            </RadioRow>
            <RadioRow
              testID="visitors-all"
              label="All friends"
              description="Everyone you are friends with, now and later."
              checked={draft.mode === 'all_friends'}
              onPress={() => void session.setAudience('all_friends')}
            />
          </View>
          <View style={styles.group}>
            <Text variant="label" color={content.ink2} heading={3}>
              What they can see
            </Text>
            {confirmed.systems.length === 0 ? (
              <Text variant="bodyS">
                You have no systems yet. They appear here as your universe grows, and none is shared until you choose.
              </Text>
            ) : null}
            {confirmed.systems.map((system) => {
              const shared = draft.systemIds.includes(system.systemId);
              return (
                <SwitchRow
                  key={system.systemId}
                  testID={`system-${system.systemId}`}
                  label={system.label}
                  description={shared ? 'Shared · visitors see its planets' : 'Private · not shown to visitors'}
                  checked={shared}
                  onPress={() => void session.toggleSystem(system.systemId)}
                />
              );
            })}
            <Text variant="meta" color={content.ink2}>
              Sharing a system shows its name and the names of its planets. Regions are never shared.
            </Text>
          </View>
          {presence ? (
            <View style={styles.group}>
              <Text variant="label" color={content.ink2} heading={3}>
                Activity status
              </Text>
              <SegmentedChoice
                label="Activity status"
                testIDPrefix="presence"
                options={PRESENCE_CHOICES}
                value={presence.preference}
                disabled={busy}
                onChange={(value) => void session.setPresence(value)}
              />
              <Text variant="meta" color={content.ink2}>
                {PRESENCE_CHOICES.find((choice) => choice.value === presence.preference)?.description} Never shows what
                you’re watching, only whether you’re around.
              </Text>
            </View>
          ) : null}
          {readReceipts ? (
            <View style={styles.group}>
              <Text variant="label" color={content.ink2} heading={3}>
                Read receipts
              </Text>
              <SwitchRow
                testID="read-receipts"
                label="Show SEEN in direct conversations"
                description={
                  readReceipts.shared
                    ? 'On: people you talk with see SEEN once you’ve read their message, and you see theirs.'
                    : 'Off: they won’t see when you’ve read their messages, and you won’t see theirs.'
                }
                checked={readReceipts.shared}
                disabled={busy}
                onPress={() => void session.setReadReceipts(!readReceipts.shared)}
              />
              <Text variant="meta" color={content.ink2}>
                If you hide yours, you won’t see theirs. It shows only in direct conversations, never in threads or
                rooms, and never says what you’ve watched or read.
              </Text>
            </View>
          ) : null}
          <SaveNote save={state.save} onRetry={() => void session.retry()} />
          <Text variant="meta" color={content.ink2}>
            Changing this applies to every later visit at once. Screenshots and anything a friend has already seen can’t
            be taken back.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: spacing[4] },
  group: { gap: spacing[2] },
  indent: { gap: spacing[2], paddingLeft: spacing[5] },
  failed: { gap: spacing[2], alignItems: 'flex-start' },
});
