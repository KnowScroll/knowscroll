import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, dimension, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, IconButton, StateBlock, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { DeletionReceiptPanel } from './deletion-receipt-panel';
import { SessionsList } from './sessions-list';
import { SettingsLabel, SettingsRow } from './settings-parts';

function PersonTile() {
  return (
    <View style={styles.tile}>
      <Icon name="person" size={32} strokeWidth={1.8} />
    </View>
  );
}

const tabNames: Readonly<Record<string, string>> = {
  explore: 'Explore',
  universe: 'Universe',
  conversations: 'Talk',
  saved: 'Keep',
};

interface TabsState {
  readonly routes: readonly { readonly key: string; readonly name: string }[];
  readonly history?: readonly { readonly type: string; readonly key?: string }[];
}

/**
 * The tab Back returns to: the tabs navigator keeps the person's own history
 * (`backBehavior="history"`), and the entry before the account is where Back goes. Opened
 * directly (a link, a reload), there is none, and Back goes to Explore.
 */
export function previousTab(state: TabsState | undefined): string {
  const history = state?.history ?? [];
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const route = state?.routes.find((candidate) => candidate.key === history[index]?.key);
    const name = route === undefined ? undefined : tabNames[route.name];
    if (name !== undefined) return name;
  }
  return 'Explore';
}

/** Signed in: who, where, the settings that exist, and the way out of this device. */
function SignedIn({ email }: { readonly email: string }) {
  const { state, manager } = useAccountScope();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const signOut = async () => {
    setBusy(true);
    setFailed(false);
    const answer = await manager.signOut();
    setBusy(false);
    setFailed(answer === 'unavailable');
  };
  return (
    <View style={styles.signedIn}>
      <View style={styles.identity}>
        <View style={styles.avatar}>
          <Text variant="title" style={styles.initial}>
            {email.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={styles.who}>
          <Text variant="meta" color={content.ink2}>
            Signed in as
          </Text>
          <Text variant="bodyS" style={styles.address} numberOfLines={2}>
            {email}
          </Text>
        </View>
      </View>
      {state.status === 'signed_in' ? <SessionsList scope={state.scope} /> : null}
      <SettingsLabel>Settings</SettingsLabel>
      <SettingsRow
        title="Privacy & history"
        description="Recording, export, clear exploration, delete"
        href="/account/privacy"
      />
      {failed ? (
        <Banner kind="offline" lead="Not signed out." message="We couldn't reach KnowScroll. Try again." />
      ) : null}
      <View style={styles.signOut}>
        <Button label="Sign out" busyLabel="Signing out…" variant="ghost" busy={busy} onPress={() => void signOut()} />
      </View>
    </View>
  );
}

/**
 * `/account` (P01), reached from the avatar on every tab (D-006 c): who is signed in, where
 * (sessions, each signed out with one question), the settings that exist, and signing out of this
 * device; signed out, the way to sign in, and the receipt of an account deletion asked for here.
 * Back names where it goes ("Back to Keep").
 */
export function AccountScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { state, manager } = useAccountScope();
  const [destination, setDestination] = useState('Explore');
  useFocusEffect(
    useCallback(() => {
      setDestination(previousTab(navigation.getParent()?.getState() as TabsState | undefined));
    }, [navigation]),
  );
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/explore');
  };
  return (
    <ScreenFrame
      tone="paper"
      title="You"
      pageTitle="Account"
      showAccount={false}
      leading={<IconButton icon="back" label={`Back to ${destination}`} onPress={back} />}
    >
      {state.status === 'signed_in' ? (
        <SignedIn email={state.scope.account.email} />
      ) : state.status === 'unavailable' ? (
        <StateBlock
          illustration={<PersonTile />}
          title="Can't reach KnowScroll"
          body="Your account appears here once the connection is back."
          actions={[{ label: 'Try again', onPress: () => void manager.refresh() }]}
        />
      ) : (
        <View style={styles.signedOut}>
          <DeletionReceiptPanel />
          <StateBlock
            illustration={<PersonTile />}
            title={
              state.status === 'signed_out' && state.reason === 'session_ended'
                ? 'You were signed out'
                : "You're not signed in"
            }
            body="Sign in with your email to keep what you save and grow your universe."
            actions={[
              {
                label: 'Sign in',
                role: 'link',
                href: '/welcome',
                variant: 'primary',
                onPress: () => router.navigate('/welcome'),
              },
            ]}
          />
        </View>
      )}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: dimension.stateTile,
    height: dimension.stateTile,
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signedIn: { gap: spacing[1] },
  signedOut: { gap: spacing[6] },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
    padding: spacing[4],
    marginBottom: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
  },
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
  address: { fontWeight: '700' },
  signOut: { paddingTop: spacing[4], alignItems: 'flex-start' },
});
