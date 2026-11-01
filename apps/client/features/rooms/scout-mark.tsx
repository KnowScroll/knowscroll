import { StyleSheet, View } from 'react-native';
import { content } from '@knowscroll/design-tokens';
import { Icon } from '@knowscroll/ui';

/**
 * The mark a member's scout wears: a paper plane on a square tile, the shape an AI is drawn in everywhere, in ink so it is never
 * mistaken for a resident's mark or a person's. Drawn for the eye only; the AI label beside it says what it is.
 */
export function ScoutMark({ size = 28, testID }: { readonly size?: number; readonly testID?: string }) {
  return (
    <View aria-hidden accessibilityElementsHidden testID={testID} style={[styles.tile, { width: size, height: size }]}>
      <Icon name="send" size={Math.round(size * 0.58)} color={content.paper} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: content.ink },
});
