import { StyleSheet, View } from 'react-native';
import { borderWidth, content, dimension, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '../../text/text';
import { printedSurface } from '../../display/printed';

/** The three looks of a play chip in the reveal: a right call, a Plot twist, and what a call earned. */
export type PlayChipTone = 'called_it' | 'plot_twist' | 'earned';

const looks: Record<PlayChipTone, { background: string; border: string; foreground: string }> = {
  called_it: { background: content.freshTint, border: content.freshInk, foreground: content.freshInk },
  plot_twist: { background: content.ink, border: content.ink, foreground: content.paper },
  earned: { background: content.continue, border: content.ink, foreground: content.onContinue },
};

/**
 * A pill in the reveal of a call ("Called it!", "Plot twist!", "+1 spark", "Combo ×2"). These are
 * the game's own words and counts (D-064): a wrong call is the best moment of the Scroll, never a
 * failure, so its pill is as strong as the right one's.
 */
export function PlayChip({
  label,
  tone,
  testID,
}: {
  readonly label: string;
  readonly tone: PlayChipTone;
  readonly testID?: string;
}) {
  const look = looks[tone];
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      // Yellow carries ink in both appearances (#666).
      {...(tone === 'earned' ? printedSurface() : {})}
      style={[styles.chip, { backgroundColor: look.background, borderColor: look.border }]}
    >
      <Text variant="label" color={look.foreground}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing['1.5'],
    minHeight: dimension.tagHeight,
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
  },
});
