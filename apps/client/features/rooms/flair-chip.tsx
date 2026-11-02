import { StyleSheet, View } from 'react-native';
import { FLAIR_WORDS } from '@knowscroll/client-core';
import type { RoomFlairKind } from '@knowscroll/contracts';
import { borderWidth, content, dimension, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/**
 * A mark a person earned in this room (R3 E5), drawn as a small pill in the mono caps the design uses. `showing` is the one that
 * stands beside their name (yellow, as a Part cue is); `earned` is a mark they have; `coming` is one they are partway to (dashed,
 * with how far). Always words, never colour alone, and never a number except a partway mark's own "2/3".
 */
export function FlairChip({
  flair,
  look = 'showing',
  detail,
  testID,
}: {
  readonly flair: RoomFlairKind;
  readonly look?: 'showing' | 'earned' | 'coming';
  /** What follows the name of the mark: "2/3" for one that is only partway, "Showing" on the person's own card. */
  readonly detail?: string;
  readonly testID?: string;
}) {
  const words = detail === undefined ? FLAIR_WORDS[flair] : `${FLAIR_WORDS[flair]} · ${detail}`;
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={look === 'coming' ? `${words}, not earned yet` : words}
      style={[styles.chip, looks[look]]}
    >
      <Text variant="label" color={look === 'coming' ? content.ink2 : content.ink}>
        {words}
      </Text>
    </View>
  );
}

const looks = StyleSheet.create({
  showing: { backgroundColor: content.continue, borderColor: content.ink, borderStyle: 'solid' },
  earned: { backgroundColor: content.paper, borderColor: content.ink, borderStyle: 'solid' },
  coming: { backgroundColor: content.paper, borderColor: content.muted, borderStyle: 'dashed' },
});

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    minHeight: dimension.tagHeight,
    justifyContent: 'center',
    paddingHorizontal: spacing['2.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
  },
});
