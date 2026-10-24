import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type {
  AccountScope,
  FriendsCommandDraft,
  FriendsCommandOperation,
  FriendsSession,
} from '@knowscroll/client-core';
import { SharingHandleSchema } from '@knowscroll/contracts';
import { borderWidth, content, layout, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, IconButton, StateBlock, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { AddFriendPanel } from './add-friend-panel';
import { FriendField } from './friend-field';
import { PairRow, type PairCommand } from './friend-rows';
import { FriendsLinks, FriendsRoster } from './friends-roster';
import type { InviteLinkStatus } from './invite-link-card';
import { useAvailability } from './use-availability';
import {
  discardInitialNativeFriendLink,
  friendInviteLink,
  friendTokenFromLink,
  takeBrowserFriendToken,
} from './friend-invite-link';
import { useFriendsSession } from './use-friends-session';

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
      showAccount={false}
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
    await session.readGroups();
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
      await session.readGroups();
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
  const pairCommand: PairCommand = (operation, input) => {
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
  const resolved =
    state.resolvedInvite.status === 'ready' && state.resolvedInvite.data.status === 'available'
      ? state.resolvedInvite.data
      : undefined;
  const inviteStatus: InviteLinkStatus = invites?.status ?? 'none';
  const copyable =
    state.command.status === 'accepted' &&
    state.command.operation === 'createInvite' &&
    state.command.delivery === 'available';
  const foundPair =
    pair && lookupData?.person.personId.toLowerCase() === pair.peer.personId.toLowerCase() ? pair : undefined;
  const addPanel = (
    <AddFriendPanel
      onClose={() => setPanel('roster')}
      disabled={disabled}
      inputsDisabled={blocked}
      handle={{
        value: handle,
        onChange: setHandle,
        canFind: SharingHandleSchema.safeParse(handle).success,
        onFind: () => void lookup(),
        searching: state.lookup.status === 'loading',
        found: lookupData?.person,
        unavailable:
          state.lookup.status === 'unavailable' ||
          (state.lookup.status === 'ready' && state.lookup.data.status === 'unavailable') ||
          state.pair.status === 'unavailable' ||
          (state.pair.status === 'ready' && state.pair.data.status === 'unavailable'),
        canSend:
          lookupData !== undefined &&
          !mutationsDisabled &&
          profile?.status === 'claimed' &&
          pair?.state === 'none' &&
          pair.peer.personId.toLowerCase() === lookupData.person.personId.toLowerCase() &&
          pair.pairRevision === lookupData.pairRevision,
        onSend: () => {
          if (lookupData)
            void execute('request', {
              expectedPeerPersonId: lookupData.person.personId,
              expectedPairRevision: lookupData.pairRevision,
              target: { kind: 'handle', handle: lookupData.person.handle },
            });
        },
        existing: foundPair ? (
          <PairRow
            pair={foundPair}
            disabled={mutationsDisabled}
            onCommand={pairCommand}
            availability={availabilityOf(foundPair.peer.personId)}
            onVisit={() => visitFriend(foundPair.peer.handle)}
          />
        ) : null,
      }}
      link={{
        status: inviteStatus,
        copyable: inviteStatus === 'active' && copyable,
        canCreate: !mutationsDisabled && profile?.status === 'claimed',
        disabled: invites === undefined || (inviteStatus === 'active' ? disabled : mutationsDisabled),
        onCreate: () => {
          if (invites) void execute('createInvite', { expectedInviteRevision: invites.inviteRevision });
        },
        onCopy: () => void copyLink(),
        onRevoke: () => {
          if (invites?.status === 'active')
            void execute('revokeInvite', { linkId: invites.linkId, expectedInviteRevision: invites.inviteRevision });
        },
      }}
      pasted={{
        value: pasted,
        onChange: (value) => {
          setPasted(value);
          resolvedToken.current = undefined;
          selectionSerial.current++;
          setInviteChecked(false);
        },
        onCheck: () => void resolve(),
        checking: state.resolvedInvite.status === 'loading',
        unavailable:
          state.resolvedInvite.status === 'unavailable' ||
          (state.resolvedInvite.status === 'ready' && state.resolvedInvite.data.status === 'unavailable'),
        issuer: resolved && inviteChecked ? resolved.issuer : undefined,
        canSend: !mutationsDisabled && profile?.status === 'claimed' && inviteChecked && !pasted,
        onSend: () => {
          const token = resolvedToken.current;
          if (token && resolved)
            void execute('request', {
              expectedPeerPersonId: resolved.issuer.personId,
              expectedPairRevision: resolved.pairRevision,
              target: { kind: 'invite', token },
            });
        },
      }}
    />
  );
  const profilePanel = (
    <Section title={profile?.status === 'claimed' ? 'Your public profile' : 'Choose your public profile'}>
      <FriendField
        label="Your handle"
        value={profileHandle}
        maxLength={24}
        onChange={setProfileHandle}
        disabled={blocked}
      />
      <Text variant="bodyS" color={content.ink2}>
        3–24 lowercase letters or numbers; single dots and underscores can separate them.
      </Text>
      <FriendField
        label="Display name"
        value={displayName}
        maxLength={80}
        onChange={setDisplayName}
        disabled={blocked}
      />
      <Button
        label="Save profile"
        variant="primary"
        fullWidth
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
      <Button label="Back to friends" variant="ghost" fullWidth onPress={() => setPanel('roster')} />
    </Section>
  );
  const editProfile = () => {
    setProfileHandle(profile?.status === 'claimed' ? profile.person.handle : '');
    setDisplayName(profile?.status === 'claimed' ? profile.person.displayName : '');
    setPanel('profile');
  };
  return (
    <View style={styles.stack}>
      {panel === 'roster' ? (
        <Button label="Add a friend" icon="plus" variant="primary" fullWidth onPress={() => setPanel('add')} />
      ) : null}
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
      {needsRefresh ? (
        <Button label="Refresh current status" variant="ghost" disabled={disabled} onPress={() => void refresh()} />
      ) : null}
      {state.profile.status === 'unavailable' || state.invites.status === 'unavailable' ? (
        <Banner
          kind="offline"
          lead="Some details couldn't be read."
          message="Refresh before editing your profile or invite link."
        />
      ) : null}
      {profile?.status === 'unclaimed' && panel !== 'profile' ? (
        <View style={styles.setup}>
          <Text variant="bodyS">Choose a public handle and name before you send a request.</Text>
          <Button label="Set up your profile" variant="ghost" onPress={editProfile} />
        </View>
      ) : null}
      {panel === 'profile' ? profilePanel : null}
      {panel === 'add' ? addPanel : null}
      {panel === 'roster' ? (
        <>
          <FriendsRoster
            groups={state.groups}
            rosterStatus={state.roster.status}
            canNext={state.canNext}
            canPrevious={state.canPrevious}
            disabled={mutationsDisabled}
            availabilityOf={availabilityOf}
            onCommand={pairCommand}
            onVisit={visitFriend}
            onNext={() => void session.nextPage()}
            onPrevious={() => void session.previousPage()}
            onRefresh={() => void refresh()}
          />
          <FriendsLinks
            profileLine={profile?.status === 'claimed' ? `@${profile.person.handle}` : 'Choose your handle and name'}
            onOpenVisibility={() => router.push('/account/privacy/visibility')}
            onEditProfile={editProfile}
          />
        </>
      ) : null}
      {invite && panel !== 'roster' ? (
        <Button
          label="Back to Friends"
          role="link"
          href="/friends"
          variant="ghost"
          onPress={() => router.replace('/friends')}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  body: { width: '100%', maxWidth: layout.measureDesktop, alignSelf: 'center' },
  stack: { gap: spacing[5] },
  setup: { gap: spacing[2], alignItems: 'flex-start' },
  section: {
    gap: spacing[4],
    paddingVertical: spacing[4],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: content.rule,
  },
});
