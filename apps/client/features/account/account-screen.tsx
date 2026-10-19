import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, dimension, radius } from '@knowscroll/design-tokens';
import { Icon, IconButton, StateBlock } from '@knowscroll/ui';
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

/**
 * `/account`, reached from the avatar on every tab (D-006 c). P01's identity, sessions and
 * settings rows all need the identity backend (S1.3, #226); until a person can sign in, the
 * screen says so and offers nothing it cannot do. Back names where it goes ("Back to Keep").
 */
export function AccountScreen() {
  const router = useRouter();
  const navigation = useNavigation();
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
      <StateBlock
        illustration={<PersonTile />}
        title="You're not signed in"
        body="Your account, sessions, privacy and settings appear here once you sign in."
      />
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
});
