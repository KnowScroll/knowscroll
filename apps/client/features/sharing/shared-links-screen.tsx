import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import { IconButton, StateBlock } from '@knowscroll/ui';
import { useAccountScope } from '../../providers/account-scope';
import { ScreenFrame } from '../shell/screen-frame';
import { SharedLinksPanel } from './shared-links-panel';

/**
 * The privacy panel of the links the person has shared (P02): see each live link and stop it.
 * `SharedLinksSection` is also what the Privacy hub mounts as its "Links you've shared" panel.
 */
export function SharedLinksSection() {
  const { state } = useAccountScope();
  if (state.status !== 'signed_in')
    return <StateBlock title="Sign in to see your links" body="Links you share are tied to your account." />;
  return <SharedLinksPanel scope={state.scope} />;
}

export function SharedLinksScreen() {
  const router = useRouter();
  return (
    <ScreenFrame
      tone="paper"
      title="Links you’ve shared"
      showAccount={false}
      leading={
        <IconButton
          icon="back"
          label="Back to privacy"
          onPress={() => (router.canGoBack() ? router.back() : router.navigate('/account/privacy'))}
        />
      }
    >
      <View style={styles.body}>
        <SharedLinksSection />
      </View>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing[4], backgroundColor: content.paper } });
