import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius } from '@knowscroll/design-tokens';
import { Icon, IconButton, StateBlock } from '@knowscroll/ui';
import { ScreenFrame } from '../shell/screen-frame';

function PersonTile() {
  return (
    <View style={styles.tile}>
      <Icon name="person" size={32} strokeWidth={1.8} />
    </View>
  );
}

/**
 * `/account`, reached from the avatar on every tab (D-006 c). P01's identity, sessions and
 * settings rows all need the identity backend (S1.3, #226); until a person can sign in, the
 * screen says so and offers nothing it cannot do.
 */
export function AccountScreen() {
  const router = useRouter();
  const back = () => {
    if (router.canGoBack()) router.back();
    else router.navigate('/explore');
  };
  return (
    <ScreenFrame
      tone="paper"
      title="You"
      showAccount={false}
      leading={<IconButton icon="back" label="Back" onPress={back} />}
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
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
