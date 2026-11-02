import { Pressable, StyleSheet, View } from 'react-native';
import { starMomentWords } from '@knowscroll/client-core';
import type { RoomStar } from '@knowscroll/contracts';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { Icon, Text } from '@knowscroll/ui';

/**
 * "How each star was earned" (R3 E5): one line for each lit star of the constellation being made, newest first. What a line says
 * is what the server read for this reader (`starMomentWords`): a person named only where the room names them, never one the reader
 * blocked, and never who marked an answer. A line that has something to open is a link to it, and one that has not is only words.
 */
export function StarMoments({
  stars,
  onOpen,
}: {
  readonly stars: readonly RoomStar[];
  readonly onOpen: (discussionId: string) => void;
}) {
  if (stars.length === 0) return null;
  return (
    <View style={styles.list} testID="star-moments">
      <Text variant="label" color={content.ink2}>
        How each star was earned
      </Text>
      <View role="list" accessibilityLabel="How each star was earned">
        {stars.map((star, index) => {
          const words = starMomentWords(star);
          const line = (
            <>
              <Icon name="star" size={16} color={content.ink} />
              <Text variant="ui" style={styles.words}>
                {words}
              </Text>
              {star.opens === undefined ? null : <Icon name="forward" size={16} color={content.ink2} />}
            </>
          );
          return (
            <View key={`${star.act}-${String(index)}`} role="listitem" style={styles.item}>
              {star.opens === undefined ? (
                <View style={styles.row} testID={`star-moment-${String(index)}`}>
                  {line}
                </View>
              ) : (
                <Pressable
                  role="link"
                  accessibilityLabel={`${words}, open it`}
                  onPress={() => onOpen(star.opens!.discussionId)}
                  style={styles.row}
                  testID={`star-moment-${String(index)}`}
                >
                  {line}
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing[1] },
  item: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing[2], paddingVertical: spacing[2] },
  words: { flexShrink: 1, flexGrow: 1 },
});
