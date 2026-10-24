import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import { createAccountSessionsSession, type AccountScope } from '@knowscroll/client-core';
import { spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Tag } from '@knowscroll/ui';
import { ago } from './relative-time';
import { SettingsLabel, StaticRow } from './settings-parts';

/** What the person was just asked about: signing out one device, or all the others. */
type Asking = { readonly kind: 'session'; readonly id: string } | { readonly kind: 'others' };

/**
 * P01 "Sessions": where this person is signed in, as coarse device names and when each was last
 * used. Signing a device out asks once, in the row itself; "other devices" does the same for all
 * of them. This device is marked and is signed out with the Sign out below, which also clears
 * its cookie.
 */
export function SessionsList({ scope }: { readonly scope: AccountScope }) {
  const sessions = useMemo(() => createAccountSessionsSession(scope), [scope]);
  const state = useSyncExternalStore(sessions.subscribe, sessions.getState, sessions.getState);
  const [asking, setAsking] = useState<Asking | undefined>(undefined);
  useEffect(() => {
    void sessions.refresh();
  }, [sessions]);
  const others = state.sessions.filter((session) => !session.current);
  const ending = state.ending !== undefined;
  const confirm = (target: Asking) => {
    setAsking(undefined);
    void (target.kind === 'others' ? sessions.endOthers() : sessions.end(target.id));
  };
  return (
    <View>
      <SettingsLabel>Sessions</SettingsLabel>
      {state.status === 'loading' ? <Skeleton rows={1} label="Loading your devices" /> : null}
      {state.status === 'unavailable' ? (
        <Banner
          kind="offline"
          lead="Can't load your devices."
          message="Check your connection."
          action={{ label: 'Retry', onPress: () => void sessions.refresh() }}
        />
      ) : null}
      {state.failed ? <Banner kind="error" lead="Couldn't sign out." message="Nothing changed. Try again." /> : null}
      {state.sessions.map((session) => {
        const sure = asking?.kind === 'session' && asking.id === session.id;
        return (
          <StaticRow
            key={session.id}
            title={session.deviceLabel}
            description={
              sure
                ? `Sign out of ${session.deviceLabel}?`
                : session.current
                  ? 'Signed in now'
                  : `Last used ${ago(session.lastUsedAt, state.readAt)}`
            }
            trailing={
              session.current ? (
                <Tag label="Current" />
              ) : sure ? (
                <View style={styles.choices}>
                  <Button label="Cancel" size="sm" variant="ghost" onPress={() => setAsking(undefined)} />
                  <Button
                    label="Sign out"
                    accessibilityLabel={`Confirm sign out of ${session.deviceLabel}`}
                    size="sm"
                    variant="danger"
                    onPress={() => confirm({ kind: 'session', id: session.id })}
                  />
                </View>
              ) : (
                <Button
                  label="Sign out"
                  size="sm"
                  variant="ghost"
                  busy={state.ending?.kind === 'session' && state.ending.id === session.id}
                  busyLabel="Signing out…"
                  disabled={ending}
                  accessibilityLabel={`Sign out ${session.deviceLabel}`}
                  onPress={() => setAsking({ kind: 'session', id: session.id })}
                />
              )
            }
          />
        );
      })}
      {others.length > 1 ? (
        <View style={styles.others}>
          {asking?.kind === 'others' ? (
            <View style={styles.choices}>
              <Button label="Cancel" size="sm" variant="ghost" onPress={() => setAsking(undefined)} />
              <Button
                label={`Sign out ${String(others.length)} other devices`}
                size="sm"
                variant="danger"
                onPress={() => confirm({ kind: 'others' })}
              />
            </View>
          ) : (
            <Button
              label="Sign out of other devices"
              variant="ghost"
              size="sm"
              busy={state.ending?.kind === 'others'}
              busyLabel="Signing out…"
              disabled={ending}
              onPress={() => setAsking({ kind: 'others' })}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: {
    flexDirection: 'row',
    gap: spacing[2],
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  others: { paddingTop: spacing[3], alignItems: 'flex-start' },
});
