import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, dimension, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, IconButton, StateBlock, Text } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';

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

/** Signed in: who, and the two ways out (this device, or every device). */
function SignedIn({ email }: { readonly email: string }) {
  const { manager } = useAccountScope();
  const [busy, setBusy] = useState<'here' | 'everywhere' | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const signOut = async (everywhere: boolean) => {
    setBusy(everywhere ? 'everywhere' : 'here');
    setFailed(false);
    const answer = await manager.signOut({ everywhere });
    setBusy(undefined);
    setFailed(answer === 'unavailable');
  };
  return (
    <View style={styles.signedIn}>
      <Text variant="meta" color={content.ink2}>
        Signed in as
      </Text>
      <Text variant="title" heading={2}>
        {email}
      </Text>
      {failed ? (
        <Banner kind="offline" lead="Not signed out." message="We couldn't reach KnowScroll. Try again." />
      ) : null}
      <Button
        label="Sign out"
        busyLabel="Signing out…"
        busy={busy === 'here'}
        disabled={busy === 'everywhere'}
        onPress={() => void signOut(false)}
      />
      <Button
        label="Sign out on every device"
        busyLabel="Signing out…"
        variant="ghost"
        busy={busy === 'everywhere'}
        disabled={busy === 'here'}
        onPress={() => void signOut(true)}
      />
    </View>
  );
}

/**
 * `/account`, reached from the avatar on every tab (D-006 c): who is signed in, and signing out
 * (here or everywhere); signed out, the way to sign in. P01's privacy and settings rows arrive
 * with the privacy work. Back names where it goes ("Back to Keep").
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
  signedIn: { gap: spacing[4], alignItems: 'flex-start' },
});
