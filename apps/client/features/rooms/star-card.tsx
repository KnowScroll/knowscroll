import { StyleSheet, View } from 'react-native';
import { ROOM_STARS_PER_CONSTELLATION, type RoomMessageStar } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';

/**
 * "+1 star for the room" (R3 F4): what an answer carries when another member found it useful and that earned the room a star.
 * It says which of the constellation's seven it lit. It is not the answer's score and names nobody: who marked it is never said
 * (D-168), and nobody owns a star. Drawn under the answer it belongs to, for everyone who reads it.
 */
export function StarCard({ star }: { readonly star: RoomMessageStar }) {
  const place = `${String(star.place)} of ${String(ROOM_STARS_PER_CONSTELLATION)}`;
  return (
    <View
      style={styles.card}
      role="group"
      accessibilityLabel={`Plus one star for the room: an answer someone found useful. Star ${place}.`}
      testID="star-card"
    >
      <Icon name="star" size={18} color={content.ink} />
      <View style={styles.words}>
        <Text variant="ui">+1 star for the room</Text>
        <Text variant="metaS" color={content.ink2}>
          Someone found this answer useful. Star {place}.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  words: { flexShrink: 1, gap: spacing[0] },
});
