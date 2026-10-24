import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import type {
  AccountScope,
  FriendsCommandDraft,
  FriendsCommandOperation,
  FriendsFilter,
  FriendsSession,
} from '@knowscroll/client-core';
import { SharingHandleSchema } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing, target } from '@knowscroll/design-tokens';
import { Banner, IconButton, StateBlock, Text, useTypeStyle } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { FriendButton as Button, FriendControls, FriendIdentity, friendsStyles } from './friend-controls';
import { useAvailability } from './use-availability';
import {
  discardInitialNativeFriendLink,
  friendInviteLink,
  friendTokenFromLink,
  takeBrowserFriendToken,
} from './friend-invite-link';
import { useFriendsSession } from './use-friends-session';

const filters: readonly { value: FriendsFilter; label: string }[] = [
  { value: 'friends', label: 'Friends' },
  { value: 'incoming', label: 'Incoming requests' },
  { value: 'outgoing', label: 'Sent requests' },
  { value: 'blocked', label: 'Blocked' },
];
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="title" heading={2}>
        {title}
      </Text>
      {children}
    </View>
  );
}
function Field({
  label,
  value,
  onChange,
  maxLength,
  secret = false,
  disabled = false,
  onSubmit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
  readonly secret?: boolean;
  readonly disabled?: boolean;
  readonly onSubmit?: () => void;
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
        secureTextEntry={secret}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        onSubmitEditing={onSubmit}
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

/** Outside the tab group: Friends is an explicit destination, never a fifth primary tab. */
export function FriendsScreen({ invite = false }: { readonly invite?: boolean }) {
  const router = useRouter();
  const { state, manager } = useAccountScope();
  // Signed-out links are deliberately discarded: a capability never crosses an account remount.
  useEffect(() => {
    if (!invite || state.status === 'signed_in') return undefined;
    discardInitialNativeFriendLink();
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    let active = true;
    const discard = () => {
      if (active) takeBrowserFriendToken();
    };
    discard();
    window.addEventListener('hashchange', discard);
    return () => {
      active = false;
      window.removeEventListener('hashchange', discard);
    };
  }, [invite, state.status]);
  const back = () => (router.canGoBack() ? router.back() : router.navigate('/conversations'));
  return (
    <ScreenFrame
      tone="paper"
      title={invite ? 'Friend invitation' : 'Friends'}
      bodyOffset={spacing[6]}
      leading={<IconButton icon="back" label="Back from Friends" onPress={back} />}
    >
      <View style={styles.body}>
        {state.status === 'signed_in' ? (
          <SignedInFriends scope={state.scope} invite={invite} />
        ) : state.status === 'unavailable' ? (
          <StateBlock
            title="Can't reach your account"
            body="Reconnect to manage friends."
            actions={[
              {
                label: 'Reconnect',
                onPress: () => {
                  void manager.refresh();
                },
              },
            ]}
          />
        ) : (
          <StateBlock
            title="Sign in to manage friends"
            body={
              invite
                ? 'Sign in, then paste the invitation again. Opening a link sends no friend request.'
                : 'Choose people by handle or an invitation link. We never upload your contacts.'
            }
            actions={[{ label: 'Sign in', role: 'link', href: '/welcome', onPress: () => router.navigate('/welcome') }]}
          />
        )}
      </View>
    </ScreenFrame>
  );
}

export function SignedInFriends({
  scope,
  invite = false,
}: {
  readonly scope: AccountScope;
  readonly invite?: boolean;
}) {
  const session = useFriendsSession(scope);
  if (!session) return <Text variant="body">Loading friends…</Text>;
  return <FriendsView session={session} scope={scope} invite={invite} />;
}

function FriendsView({
  session,
  scope,
  invite,
}: {
  readonly session: FriendsSession;
  readonly scope: AccountScope;
  readonly invite: boolean;
}) {
  const router = useRouter();
  const availabilityOf = useAvailability(scope);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const snapshot = useCallback(() => session.getState(), [session]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [panel, setPanel] = useState<'roster' | 'add' | 'profile'>(invite ? 'add' : 'roster');
  const [handle, setHandle] = useState('');
  const [profileHandle, setProfileHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pasted, setPasted] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [inviteChecked, setInviteChecked] = useState(false);
  const workingRef = useRef(false);
  const resolvedToken = useRef<string | undefined>(undefined);
  const selectionSerial = useRef(0);
  const mounted = useRef(true);
  const blocked = working || state.command.status === 'pending' || state.command.status === 'unknown';
  const loadingRead = [state.profile, state.invites, state.lookup, state.pair, state.resolvedInvite, state.roster].some(
    (s) => s.status === 'loading',
  );
  const disabled = blocked || loadingRead;
  const mutationsDisabled = disabled || needsRefresh;
  const live = () => mounted.current && scope.active && session.getState().status === 'active';
  const refresh = async () => {
    // Discard target choices before a new current snapshot; receipts cannot revive them.
    setHandle('');
    setPasted('');
    setInviteChecked(false);
    resolvedToken.current = undefined;
    selectionSerial.current++;
    await session.readProfile();
    if (!live()) return;
    await session.readInvites();
    if (!live()) return;
    await session.selectFilter(session.getState().filter);
    const current = session.getState();
    if (
      live() &&
      current.profile.status === 'ready' &&
      current.invites.status === 'ready' &&
      current.roster.status === 'ready'
    )
      setNeedsRefresh(false);
  };
  // One underlying foreground read + latest queued selection: independent initial reads MUST be sequential.
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      await session.readProfile();
      if (!scope.active || session.getState().status !== 'active') return;
      await session.readInvites();
      if (!scope.active || session.getState().status !== 'active') return;
      await session.selectFilter('friends');
    })();
    const clear = () => {
      resolvedToken.current = undefined;
      selectionSerial.current++;
      setInviteChecked(false);
      setPasted('');
      setHandle('');
      setProfileHandle('');
      setDisplayName('');
      setNote('');
    };
    const off = scope.onEnd?.(clear);
    return () => {
      mounted.current = false;
      resolvedToken.current = undefined;
      off?.();
    };
  }, [session, scope]);
  // New link events belong only to this mounted scope. Every fragment change first removes its
  // URL secret and invalidates former choices; neither valid nor invalid intake starts a read.
  useEffect(() => {
    if (!invite) return undefined;
    let active = true;
    const receive = (token: string | undefined) => {
      if (!active || !scope.active || session.getState().status !== 'active') return;
      selectionSerial.current++;
      resolvedToken.current = token;
      setPasted('');
      setHandle('');
      setProfileHandle('');
      setDisplayName('');
      setInviteChecked(false);
      setPanel('add');
      setNote(
        token
          ? 'Invitation received. Choose Check invitation to see who it is from.'
          : 'Paste the invitation again, then choose Check invitation. Opening a link sends no request.',
      );
    };
    const clear = () => {
      active = false;
      resolvedToken.current = undefined;
      selectionSerial.current++;
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const take = () => {
        if (!active) return;
        // Even an ended scope discards the fragment; it cannot retain it for a later account.
        receive(takeBrowserFriendToken());
      };
      take();
      window.addEventListener('hashchange', take);
      return () => {
        clear();
        window.removeEventListener('hashchange', take);
      };
    }
    discardInitialNativeFriendLink();
    receive(undefined);
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (active) receive(friendTokenFromLink(url));
    });
    return () => {
      clear();
      subscription.remove();
    };
  }, [invite, scope, session]);

  /** A friend's universe. Whether anything is shown is the server's answer, not something this row knows. */
  const visitFriend = (friendHandle: string) => router.push(`/visit/${encodeURIComponent(friendHandle)}`);

  async function execute<K extends FriendsCommandOperation>(operation: K, input: FriendsCommandDraft<K>) {
    if (!live() || workingRef.current || blocked || needsRefresh) return;
    workingRef.current = true;
    setWorking(true);
    setNote('');
    try {
      await session.command(operation, input);
      resolvedToken.current = undefined;
      setPasted('');
      setInviteChecked(false);
      if (live() && session.getState().command.status === 'rejected') setNeedsRefresh(true);
      if (live() && session.getState().command.status === 'accepted') await refresh();
    } finally {
      workingRef.current = false;
      if (live()) setWorking(false);
    }
  }
  async function retry() {
    if (!live() || workingRef.current) return;
    workingRef.current = true;
    setWorking(true);
    try {
      await session.retryCommand();
      if (live() && session.getState().command.status === 'accepted') await refresh();
    } finally {
      workingRef.current = false;
      if (live()) setWorking(false);
    }
  }
  const pairCommand = (
    operation: 'accept' | 'decline' | 'cancel' | 'remove' | 'block' | 'unblock',
    input: { peerPersonId: string; expectedPairRevision: number; requestId?: string },
  ) => {
    const base = { peerPersonId: input.peerPersonId, expectedPairRevision: input.expectedPairRevision };
    if (operation === 'accept' || operation === 'decline' || operation === 'cancel') {
      if (input.requestId) void execute(operation, { ...base, requestId: input.requestId });
    } else void execute(operation, base);
  };
  async function copyLink() {
    if (!live() || disabled) return;
    // No React state, rendered URL, storage, route or log retains the one-shot delivery.
    const token = session.takeInviteToken();
    const url = token ? friendInviteLink(token) : undefined;
    if (!url) {
      setNote('The link can no longer be copied. Refresh its status, revoke it, then create a new link if needed.');
      return;
    }
    setWorking(true);
    workingRef.current = true;
    try {
      await Clipboard.setStringAsync(url);
      if (live()) setNote('Invite link copied. Share it only with people you choose.');
    } catch {
      if (live())
        setNote('Could not copy the link. Its one-time delivery is gone. Revoke it before creating a new link.');
    } finally {
      workingRef.current = false;
      if (live()) setWorking(false);
    }
  }
  async function lookup() {
    if (!live() || disabled || !SharingHandleSchema.safeParse(handle).success) return;
    const mine = ++selectionSerial.current;
    await session.lookup(handle);
    const result = session.getState().lookup;
    if (mine === selectionSerial.current && live() && result.status === 'ready' && result.data.status === 'available')
      await session.readPair(result.data.person.personId);
  }
  async function resolve() {
    if (!live() || disabled) return;
    const token = pasted ? friendTokenFromLink(pasted) : resolvedToken.current;
    setPasted('');
    resolvedToken.current = undefined;
    setInviteChecked(false);
    if (!token) {
      setNote('Paste a complete friend invitation link.');
      return;
    }
    const mine = ++selectionSerial.current;
    resolvedToken.current = token;
    await session.resolveInvite(token);
    if (mine !== selectionSerial.current) return;
    const result = session.getState().resolvedInvite;
    if (!live() || result.status !== 'ready' || result.data.status !== 'available') resolvedToken.current = undefined;
    else setInviteChecked(true);
  }
  if (state.status === 'ended')
    return (
      <StateBlock
        title="Friends session ended"
        body="Return to your account and reconnect before making another choice."
        actions={[
          { label: 'Go to account', role: 'link', href: '/account', onPress: () => router.navigate('/account') },
        ]}
      />
    );
  const profile = state.profile.status === 'ready' ? state.profile.data : undefined;
  const invites = state.invites.status === 'ready' ? state.invites.data.invite : undefined;
  const lookupData =
    state.lookup.status === 'ready' &&
    state.lookup.data.status === 'available' &&
    state.lookup.data.person.handle === handle
      ? state.lookup.data
      : undefined;
  const pair =
    state.pair.status === 'ready' && state.pair.data.status === 'available' ? state.pair.data.pair : undefined;
  const rosterItems = state.roster.status === 'ready' ? state.roster.data.items : [];
  const resolved =
    state.resolvedInvite.status === 'ready' && state.resolvedInvite.data.status === 'available'
      ? state.resolvedInvite.data
      : undefined;
  return (
    <View style={styles.stack}>
      <Text variant="bodyS" color={content.ink2}>
        Choose people by handle or an invite link. We never upload your contacts.
      </Text>
      <View style={styles.actions}>
        <Button label="Add a friend" variant={panel === 'add' ? 'primary' : 'ghost'} onPress={() => setPanel('add')} />
        <Button
          label={profile?.status === 'claimed' ? 'Edit your profile' : 'Set up your profile'}
          variant="ghost"
          onPress={() => {
            setProfileHandle(profile?.status === 'claimed' ? profile.person.handle : '');
            setDisplayName(profile?.status === 'claimed' ? profile.person.displayName : '');
            setPanel('profile');
          }}
        />
        {panel !== 'roster' ? <Button label="Show roster" variant="ghost" onPress={() => setPanel('roster')} /> : null}
      </View>
      <View accessibilityLiveRegion="polite">
        {state.command.status === 'pending' ? <Text variant="bodyS">Sending your choice…</Text> : null}
        {state.command.status === 'unknown' ? (
          <View style={styles.stack}>
            <Banner
              kind="offline"
              lead="The result is unknown."
              message="Your choice may already be recorded. Retry the same request before making another choice."
            />
            <Button
              label="Retry the same request"
              disabled={working}
              onPress={() => {
                void retry();
              }}
            />
          </View>
        ) : null}
        {state.command.status === 'accepted' ? (
          <Text variant="bodyS">Your choice was recorded. Check the latest status below.</Text>
        ) : null}
        {state.command.status === 'rejected' ? (
          <Text variant="bodyS">That choice could not be confirmed. Refresh current status before choosing again.</Text>
        ) : null}
        {note ? <Text variant="bodyS">{note}</Text> : null}
      </View>
      {state.profile.status === 'unavailable' || state.invites.status === 'unavailable' ? (
        <Banner
          kind="offline"
          lead="Some details couldn't be read."
          message="Refresh before editing your profile or invite link."
        />
      ) : null}
      <Button
        label="Refresh current status"
        variant="ghost"
        disabled={disabled}
        onPress={() => {
          void refresh();
        }}
      />
      {profile?.status === 'unclaimed' && panel !== 'profile' ? (
        <Text variant="bodyS">Choose a public handle and name in Set up your profile before sending a request.</Text>
      ) : null}
      {panel === 'profile' ? (
        <Section title={profile?.status === 'claimed' ? 'Your public profile' : 'Choose your public profile'}>
          <Field
            label="Your handle"
            value={profileHandle}
            maxLength={24}
            onChange={setProfileHandle}
            disabled={blocked}
          />
          <Text variant="bodyS" color={content.ink2}>
            3–24 lowercase letters or numbers; single dots and underscores can separate them.
          </Text>
          <Field label="Display name" value={displayName} maxLength={80} onChange={setDisplayName} disabled={blocked} />
          <Button
            label="Save profile"
            variant="primary"
            disabled={
              mutationsDisabled ||
              !profile ||
              !SharingHandleSchema.safeParse(profileHandle).success ||
              displayName.trim() !== displayName ||
              !displayName
            }
            onPress={() => {
              if (profile)
                void execute('setProfile', {
                  expectedProfileRevision: profile.profileRevision,
                  handle: profileHandle,
                  displayName,
                });
            }}
          />
        </Section>
      ) : null}
      {panel === 'add' ? (
        <Section title="Add a friend">
          <Field
            label="Their handle"
            value={handle}
            maxLength={24}
            onChange={setHandle}
            disabled={blocked}
            onSubmit={() => {
              void lookup();
            }}
          />
          <Button
            label="Find handle"
            disabled={disabled || !SharingHandleSchema.safeParse(handle).success}
            onPress={() => {
              void lookup();
            }}
          />
          {state.lookup.status === 'loading' ? <Text variant="bodyS">Checking handle…</Text> : null}
          {state.lookup.status === 'unavailable' ||
          (state.lookup.status === 'ready' && state.lookup.data.status === 'unavailable') ? (
            <Text variant="bodyS">This person is unavailable. Check the handle or try again.</Text>
          ) : null}
          {lookupData ? (
            <View style={styles.card}>
              <FriendIdentity person={lookupData.person} />
              <Button
                label={`Send request to ${lookupData.person.displayName}`}
                variant="primary"
                disabled={
                  mutationsDisabled ||
                  profile?.status !== 'claimed' ||
                  pair?.state !== 'none' ||
                  pair.peer.personId.toLowerCase() !== lookupData.person.personId.toLowerCase() ||
                  pair.pairRevision !== lookupData.pairRevision
                }
                onPress={() => {
                  void execute('request', {
                    expectedPeerPersonId: lookupData.person.personId,
                    expectedPairRevision: lookupData.pairRevision,
                    target: { kind: 'handle', handle: lookupData.person.handle },
                  });
                }}
              />
            </View>
          ) : null}
          {pair && lookupData?.person.personId.toLowerCase() === pair.peer.personId.toLowerCase() ? (
            <FriendControls
              pair={pair}
              disabled={mutationsDisabled}
              onCommand={pairCommand}
              availability={availabilityOf(pair.peer.personId)}
              onVisit={() => visitFriend(pair.peer.handle)}
            />
          ) : null}
          {state.pair.status === 'unavailable' ||
          (state.pair.status === 'ready' && state.pair.data.status === 'unavailable') ? (
            <Text variant="bodyS">Current relationship is unavailable. Find the handle again before choosing.</Text>
          ) : null}
          <Field
            label="Friend invite link"
            value={pasted}
            maxLength={2048}
            secret
            onChange={(value) => {
              setPasted(value);
              resolvedToken.current = undefined;
              selectionSerial.current++;
              setInviteChecked(false);
            }}
            disabled={blocked}
            onSubmit={() => {
              void resolve();
            }}
          />
          <Button
            label="Check invitation"
            disabled={disabled}
            onPress={() => {
              void resolve();
            }}
          />
          {state.resolvedInvite.status === 'loading' ? <Text variant="bodyS">Checking invitation…</Text> : null}
          {state.resolvedInvite.status === 'unavailable' ||
          (state.resolvedInvite.status === 'ready' && state.resolvedInvite.data.status === 'unavailable') ? (
            <Text variant="bodyS">This invitation is unavailable. It may no longer work.</Text>
          ) : null}
          {resolved && inviteChecked ? (
            <View style={styles.card}>
              <FriendIdentity person={resolved.issuer} />
              <Text variant="bodyS">
                Opening or checking this link sends no request. They still choose whether to accept.
              </Text>
              <Button
                label={`Request friendship with ${resolved.issuer.displayName}`}
                variant="primary"
                disabled={mutationsDisabled || profile?.status !== 'claimed' || !inviteChecked || !!pasted}
                onPress={() => {
                  const token = resolvedToken.current;
                  if (token)
                    void execute('request', {
                      expectedPeerPersonId: resolved.issuer.personId,
                      expectedPairRevision: resolved.pairRevision,
                      target: { kind: 'invite', token },
                    });
                }}
              />
            </View>
          ) : null}
          <Section title="Your invite link">
            <Text variant="bodyS">
              Anyone with your link can ask to be your friend. Links last seven days unless you revoke them.
            </Text>
            {invites ? (
              <>
                <Text variant="bodyS">
                  {invites.status === 'active'
                    ? 'Your invite link is active.'
                    : invites.status === 'none'
                      ? 'You have no invite link yet.'
                      : 'Your invite link is no longer active.'}
                </Text>
                <View style={styles.actions}>
                  {invites.status === 'active' ? (
                    <Button
                      label="Revoke invite link"
                      variant="ghost"
                      disabled={mutationsDisabled}
                      onPress={() => {
                        void execute('revokeInvite', {
                          linkId: invites.linkId,
                          expectedInviteRevision: invites.inviteRevision,
                        });
                      }}
                    />
                  ) : (
                    <Button
                      label="Create invite link"
                      disabled={mutationsDisabled || profile?.status !== 'claimed'}
                      onPress={() => {
                        void execute('createInvite', { expectedInviteRevision: invites.inviteRevision });
                      }}
                    />
                  )}
                  {invites.status === 'active' &&
                  state.command.status === 'accepted' &&
                  state.command.operation === 'createInvite' &&
                  state.command.delivery === 'available' ? (
                    <Button
                      label="Copy invite link once"
                      disabled={disabled}
                      onPress={() => {
                        void copyLink();
                      }}
                    />
                  ) : null}
                </View>
                {invites.status === 'active' &&
                !(
                  state.command.status === 'accepted' &&
                  state.command.operation === 'createInvite' &&
                  state.command.delivery === 'available'
                ) ? (
                  <Text variant="bodyS">
                    The secret link is not available again. If it was lost, revoke this link before creating another.
                  </Text>
                ) : null}
              </>
            ) : (
              <Text variant="bodyS">Refresh your invite link status.</Text>
            )}
          </Section>
        </Section>
      ) : null}
      <Section title={filters.find((filter) => filter.value === state.filter)!.label}>
        <View style={styles.actions} role="group" accessibilityLabel="Friends roster filters">
          {filters.map((filter) => (
            <Button
              key={filter.value}
              label={filter.label}
              toggled={state.filter === filter.value}
              variant={state.filter === filter.value ? 'primary' : 'ghost'}
              disabled={blocked || loadingRead}
              onPress={() => {
                void session.selectFilter(filter.value);
              }}
            />
          ))}
        </View>
        {state.roster.status === 'idle' || state.roster.status === 'loading' ? (
          <Text variant="bodyS">Loading this page…</Text>
        ) : state.roster.status === 'unavailable' ? (
          <Banner
            kind="offline"
            lead="This page couldn't be read."
            message="Refresh to start a current list. A failed read does not mean there are no friends."
          />
        ) : (
          <>
            {rosterItems.length === 0 ? (
              <Text variant="bodyS">
                {state.canNext
                  ? 'No visible people in this part of the scan. Choose Next to continue.'
                  : state.canPrevious
                    ? 'No visible people on this final page.'
                    : 'No people to show in this list.'}
              </Text>
            ) : null}
            {rosterItems.map((item) => (
              <FriendControls
                key={item.peer.personId}
                pair={item}
                disabled={mutationsDisabled}
                onCommand={pairCommand}
                availability={availabilityOf(item.peer.personId)}
                onVisit={() => visitFriend(item.peer.handle)}
              />
            ))}
          </>
        )}
        <View style={styles.actions}>
          <Button
            label="Previous page"
            disabled={blocked || loadingRead || !state.canPrevious}
            onPress={() => {
              void session.previousPage();
            }}
          />
          <Button
            label="Next page"
            disabled={blocked || loadingRead || !state.canNext}
            onPress={() => {
              void session.nextPage();
            }}
          />
          <Button
            label="Refresh roster"
            variant="ghost"
            disabled={blocked || loadingRead}
            onPress={() => {
              void session.refreshPage();
            }}
          />
        </View>
        <Text variant="meta" color={content.ink2}>
          Previous returns through up to eight recent pages. Refresh starts a new current list.
        </Text>
      </Section>
      <Text variant="bodyS" color={content.ink2}>
        Who can visit your universe, and whether friends see you online, is in Privacy & history under Sharing &
        visibility.
      </Text>
      {invite ? (
        <Button
          label="Back to Friends"
          role="link"
          href="/friends"
          variant="ghost"
          onPress={() => router.replace('/friends')}
        />
      ) : (
        <Button
          label="Open an invitation"
          role="link"
          href="/friends/invite"
          variant="ghost"
          onPress={() => router.push('/friends/invite')}
        />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  ...friendsStyles,
  body: { width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
  stack: { gap: spacing[5] },
  section: {
    gap: spacing[4],
    paddingVertical: spacing[4],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
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
