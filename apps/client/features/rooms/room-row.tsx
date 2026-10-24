import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { RoomListItem } from '@knowscroll/contracts';
import { borderWidth, content, spacing } from '@knowscroll/design-tokens';
import { Icon, RowLink, Tag, Text } from '@knowscroll/ui';
import { roomHref } from './room-links';

/** The words under a room's name in Talk: what the room is about, or that the person was invited. No counts, no activity. */
export function roomRowSubtitle(item: RoomListItem): string {
  if (item.standing === 'invited') return 'You’re invited to this room';
  return item.room.status === 'open' ? `A room about ${item.room.topic.label.toLowerCase()}` : 'A room · paused';
}

/** A room the person belongs to or was invited to, listed in Talk (D-006 o). Opening it records nothing about anyone. */
export function RoomRow({ item }: { readonly item: RoomListItem }) {
  const router = useRouter();
  const href = roomHref(item.room.roomId);
  const subtitle = roomRowSubtitle(item);
  return (
    <View style={styles.frame}>
      <RowLink
        label={`Room ${item.room.name}, ${subtitle}`}
        href={href}
        onPress={() => router.push(href)}
        testID={`talk-room-${item.room.roomId}`}
      >
        <View style={styles.row}>
          <View style={styles.tile} aria-hidden>
            <Icon name="universe" size={20} color={content.paper} />
          </View>
          <View style={styles.text}>
            <View style={styles.title}>
              <Text variant="bodyS" numberOfLines={1} style={styles.grow}>
                {item.room.name}
              </Text>
              {item.standing === 'invited' ? <Tag variant="part" label="Invited" /> : null}
            </View>
            <Text variant="meta" color={content.ink2} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>
        </View>
      </RowLink>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  tile: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.ink,
  },
  text: { flex: 1, gap: spacing['0.5'] },
  title: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
});
