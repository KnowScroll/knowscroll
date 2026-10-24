import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { AccountScope, FriendsSession, FriendsState } from '@knowscroll/client-core';
import { SharingHandleSchema, isPublicLabel } from '@knowscroll/contracts';
import { borderWidth, content, elevation, radius, spacing, target } from '@knowscroll/design-tokens';
import { Banner, Button, Text, useTypeStyle } from '@knowscroll/ui';
import { useFriendsSession } from '../friends/use-friends-session';

interface Profile {
  readonly handle: string;
  readonly displayName: string;
}

/** The public name and handle people see for this account, once chosen. */
function claimedProfile(state: FriendsState): Profile | undefined {
  const read = state.profile.status === 'ready' ? state.profile.data : undefined;
  return read?.status === 'claimed' ? read.person : undefined;
}

function useFriendsState(session: FriendsSession): FriendsState {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const snapshot = useCallback(() => session.getState(), [session]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function Field({
  label,
  value,
  onChange,
  maxLength,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly disabled: boolean;
}) {
  const type = useTypeStyle('bodyS');
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text variant="uiS">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        maxLength={maxLength}
        editable={!disabled}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        allowFontScaling={false}
        style={[
          styles.input,
          {
            fontFamily: type.fontFamily,
            fontSize: type.fontSize,
            lineHeight: type.lineHeight,
            borderColor: focused ? content.accent : content.ink,
          },
        ]}
      />
    </View>
  );
}

/**
 * The form behind Edit: the public name and handle friends see. Saving sends one command bound to
 * the profile revision that was read; a changed profile asks for a reload rather than overwriting.
 */
function ProfileEditor({
  session,
  scope,
  onDone,
}: {
  readonly session: FriendsSession;
  readonly scope: AccountScope;
  readonly onDone: () => void;
}) {
  const state = useFriendsState(session);
  const current = claimedProfile(state);
  const [handle, setHandle] = useState(current?.handle ?? '');
  const [displayName, setDisplayName] = useState(current?.displayName ?? '');
  const [outcome, setOutcome] = useState<'rejected' | 'unknown' | undefined>(undefined);
  const profile = state.profile.status === 'ready' ? state.profile.data : undefined;
  const pending = state.command.status === 'pending';
  const valid = SharingHandleSchema.safeParse(handle).success && displayName.length > 0 && isPublicLabel(displayName);

  const save = async () => {
    if (profile === undefined || !valid || !scope.active) return;
    setOutcome(undefined);
    await session.command('setProfile', {
      expectedProfileRevision: profile.profileRevision,
      handle,
      displayName,
    });
    const command = session.getState().command.status;
    if (command === 'accepted') {
      await session.readProfile();
      onDone();
    } else if (command === 'rejected') {
      setOutcome('rejected');
      await session.readProfile();
    } else if (command === 'unknown') setOutcome('unknown');
  };
  const retry = async () => {
    setOutcome(undefined);
    await session.retryCommand();
    if (session.getState().command.status === 'accepted') {
      await session.readProfile();
      onDone();
    } else setOutcome('unknown');
  };

  return (
    <View style={styles.editor}>
      <Field label="Display name" value={displayName} maxLength={80} onChange={setDisplayName} disabled={pending} />
      <Field label="Your handle" value={handle} maxLength={24} onChange={setHandle} disabled={pending} />
      <Text variant="meta" color={content.ink2}>
        3 to 24 lowercase letters or numbers; single dots and underscores can separate them. Friends find you by it.
      </Text>
      {outcome === 'rejected' ? (
        <Banner
          kind="error"
          lead="Your profile changed or the handle is taken."
          message="Nothing was saved. Check it and save again."
        />
      ) : null}
      {outcome === 'unknown' ? (
        <Banner
          kind="error"
          lead="We couldn't confirm the save."
          message="Retrying sends the same change, so it can't apply twice."
          action={{ label: 'Retry', onPress: () => void retry() }}
        />
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Save"
          variant="primary"
          size="sm"
          busy={pending}
          busyLabel="Saving…"
          disabled={!valid || profile === undefined}
          onPress={() => void save()}
        />
        <Button label="Cancel" variant="ghost" size="sm" disabled={pending} onPress={onDone} />
      </View>
    </View>
  );
}

/** What the card shows: the person, and Edit when their profile could be read. */
function CardView({
  email,
  profile,
  canEdit,
  editing,
  onEdit,
  children,
}: {
  readonly email: string;
  readonly profile: Profile | undefined;
  readonly canEdit: boolean;
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly children?: ReactNode;
}) {
  const name = profile?.displayName ?? email;
  return (
    <View style={styles.card}>
      <View style={styles.identity}>
        <View style={styles.avatar} aria-hidden>
          <Text variant="title" style={styles.initial}>
            {[...name][0]?.toUpperCase()}
          </Text>
        </View>
        <View style={styles.who}>
          {profile === undefined ? (
            <>
              <Text variant="meta" color={content.ink2}>
                Signed in as
              </Text>
              <Text variant="bodyS" style={styles.name} numberOfLines={2}>
                {email}
              </Text>
            </>
          ) : (
            <>
              <Text variant="ui" style={styles.name} numberOfLines={1}>
                {profile.displayName}
              </Text>
              <Text variant="meta" color={content.ink2} numberOfLines={2}>
                @{profile.handle} · {email}
              </Text>
            </>
          )}
        </View>
        {canEdit && !editing ? (
          <Button
            label="Edit"
            size="sm"
            accessibilityLabel={profile === undefined ? 'Set up your profile' : 'Edit your profile'}
            onPress={onEdit}
          />
        ) : null}
      </View>
      {children}
    </View>
  );
}

function CardWithProfile({
  email,
  scope,
  session,
}: {
  readonly email: string;
  readonly scope: AccountScope;
  readonly session: FriendsSession;
}) {
  const [editing, setEditing] = useState(false);
  const state = useFriendsState(session);
  useEffect(() => {
    void session.readProfile();
  }, [session]);
  return (
    <CardView
      email={email}
      profile={claimedProfile(state)}
      canEdit={state.profile.status === 'ready'}
      editing={editing}
      onEdit={() => setEditing(true)}
    >
      {editing ? <ProfileEditor session={session} scope={scope} onDone={() => setEditing(false)} /> : null}
    </CardView>
  );
}

/**
 * P01's identity card: the avatar, the name and handle friends see, the account's email and Edit.
 * Without a chosen profile it shows the email, and Edit sets one up. The profile is the same one
 * Friends & visibility uses; this is only another way to change it.
 */
export function IdentityCard({ scope, email }: { readonly scope: AccountScope; readonly email: string }) {
  const session = useFriendsSession(scope);
  if (session === undefined)
    return <CardView email={email} profile={undefined} canEdit={false} editing={false} onEdit={noop} />;
  return <CardWithProfile email={email} scope={scope} session={session} />;
}

const noop = () => undefined;

const styles = StyleSheet.create({
  card: {
    gap: spacing[4],
    padding: spacing[4],
    marginBottom: spacing[2],
    marginRight: 6,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.paper,
    boxShadow: elevation.hero,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing[4] },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { color: content.onContinue },
  who: { flex: 1, minWidth: 0 },
  name: { fontWeight: '700' },
  address: { fontWeight: '700' },
  editor: { gap: spacing[3] },
  actions: { flexDirection: 'row', gap: spacing[3] },
  field: { gap: spacing[2] },
  input: {
    color: content.ink,
    backgroundColor: content.paper2,
    minHeight: target.comfortable,
    borderWidth: borderWidth.regular,
    borderRadius: radius.md,
    paddingHorizontal: spacing['3.5'],
    paddingVertical: spacing[3],
  },
});
