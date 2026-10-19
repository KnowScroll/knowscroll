import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius } from '@knowscroll/design-tokens';
import { Icon, StateBlock, Text } from '@knowscroll/ui';
import { ScreenFrame } from '../shell/screen-frame';

/** S01's empty tile: a dashed 72 px square with the Keep bookmark. */
function KeepTile() {
  return (
    <View style={styles.tile}>
      <Icon name="keep" size={32} strokeWidth={1.8} />
    </View>
  );
}

/** S01 "Empty · first visit, nothing kept". The only action is the way to something to keep. */
export function EmptyKeepScreen() {
  const router = useRouter();
  return (
    <ScreenFrame tone="paper" title="Keep">
      <StateBlock
        illustration={<KeepTile />}
        title="Nothing kept yet"
        body={
          <>
            Tap{' '}
            <Text variant="body" color={content.ink} style={styles.emphasis}>
              Save
            </Text>{' '}
            on any Reel or Scroll and it lands here, with your place kept. Requests you make show up here too.
          </>
        }
        actions={[
          { label: 'Go to Explore', variant: 'primary', role: 'link', onPress: () => router.navigate('/explore') },
        ]}
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
  emphasis: { fontWeight: '700' },
});
