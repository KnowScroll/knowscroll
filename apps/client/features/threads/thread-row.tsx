import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { listTime, threadRowView } from '@knowscroll/client-core';
import type { ThreadSummary } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Icon, RowLink, Text } from '@knowscroll/ui';
import { threadHref } from './thread-links';

/** A thread in Talk: the content it is about, who invited or what was said last. Reading it records nothing about anyone. */
export function ThreadRow({ item }: { readonly item: ThreadSummary }) {
  const router = useRouter();
  const view = threadRowView(item);
  const href = threadHref(item.thread);
  const time = listTime(view.at, new Date());
  const kind =
    item.root.status === 'available'
      ? item.root.metadata.kind
      : item.root.status === 'corrected'
        ? item.root.current.metadata.kind
        : 'reel';
  return (
    <View style={styles.rowFrame}>
      <RowLink
        label={`Thread ${view.title}${view.unread ? ', unread' : ''}, ${view.subtitle}, ${time}`}
        href={href}
        onPress={() => router.push(href)}
        testID={`talk-thread-${item.thread.threadId}`}
      >
        <View style={styles.row}>
          <View style={styles.tile} aria-hidden>
            <Icon name={kind === 'reel' ? 'reel' : 'scroll'} size={20} color={content.paper} />
          </View>
          <View style={styles.text}>
            <View style={styles.title}>
              <Text variant={view.unread ? 'ui' : 'bodyS'} numberOfLines={1} style={styles.grow}>
                {view.title}
              </Text>
            </View>
            <Text variant="meta" color={content.ink2} numberOfLines={1}>
              {view.subtitle}
            </Text>
          </View>
          <View style={styles.end}>
            <Text variant="monoXs" color={content.ink2}>
              {time}
            </Text>
            {view.unread ? <View style={styles.dot} /> : null}
          </View>
        </View>
      </RowLink>
    </View>
  );
}

const styles = StyleSheet.create({
  rowFrame: { borderBottomWidth: borderWidth.hairline, borderBottomColor: content.rule },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: content.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing['0.5'] },
  title: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  grow: { flex: 1 },
  end: { alignItems: 'flex-end', gap: spacing[2], minWidth: 44 },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: content.accent },
});
