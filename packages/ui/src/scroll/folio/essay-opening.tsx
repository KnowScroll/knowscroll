import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { spacing } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';
import { usePagePalette } from '../page/page-palette';

export interface EssayOpeningProps {
  readonly kicker: string;
  readonly title: string;
  readonly dek: string;
  /** What the screen sets above the kicker (the essay's link back to the Part before). */
  readonly before?: ReactNode;
  /** Layout only: where the opening sits (the essay's column width). */
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * The three lines an essay opens with: kicker, title, dek. The essay and the cover that opens into it both draw them
 * here, so the type is the same and opening a cover reads as the same page unfolding. The title is the screen's one
 * heading: a cover replaces the essay on screen rather than sitting beside it.
 */
export function EssayOpening({ kicker, title, dek, before, style }: EssayOpeningProps) {
  const page = usePagePalette();
  return (
    <View style={[styles.opening, style]}>
      {before}
      <Text variant="label" color={page.link}>
        {kicker}
      </Text>
      <Text variant="page" heading={1} color={page.ink}>
        {title}
      </Text>
      <Text variant="bodyS" color={page.ink2}>
        {dek}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  opening: { gap: spacing[2], paddingTop: spacing[6] },
});
