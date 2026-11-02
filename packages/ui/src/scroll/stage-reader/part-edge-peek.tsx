import { Pressable, StyleSheet } from 'react-native';
import { borderWidth, content, radius, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import type { NextPartPeek } from './end-tray';

/**
 * The next Part peeking in from the right edge of the picture once the Scroll is at its end (V3 F10, E1): a yellow tab with
 * its label and an arrow, the same move as the dock's way on, the → key and a swipe left. It is the continuation yellow's one
 * place at the end (D-006 b); the other ways on stay in the tray at one weight (D-189). It names the Part, never invents what
 * is in it.
 */
export function PartEdgePeek({ peek, top }: { readonly peek: NextPartPeek; readonly top: number }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      accessibilityRole="button"
      accessibilityLabel={`Continue ${peek.label}`}
      accessibilityHint={peek.title}
      onPress={peek.onPress}
      style={[styles.tab, { top }, focus.style]}
      testID="part-edge-peek"
    >
      <Text variant="monoXs" color={content.onContinue}>
        {peek.label.toUpperCase()}
      </Text>
      <Icon name="arrowRight" size={20} color={content.onContinue} strokeWidth={2.4} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tab: {
    position: 'absolute',
    right: 0,
    minWidth: target.minimum + spacing[4],
    minHeight: target.minimum + spacing[6],
    paddingHorizontal: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    borderTopLeftRadius: radius.card,
    borderBottomLeftRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderRightWidth: 0,
    borderColor: content.ink,
    backgroundColor: content.continue,
    cursor: 'pointer' as const,
  },
});
