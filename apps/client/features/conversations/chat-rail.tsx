import { StyleSheet, View } from 'react-native';
import { listTime } from '@knowscroll/client-core';
import type { PublicPersonRef } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text, useTalkTheme } from '@knowscroll/ui';
import { PersonAvatar } from './person-avatar';
import type { SharedHere } from './shared-here';

/** The width of the rail beside an open conversation on a desktop (T3 "In this chat"). */
export const CHAT_RAIL_WIDTH = 300;

/**
 * T3's right rail on a desktop conversation: who the chat is with, what was sent in it (Shared here), and, when a card
 * was shared, the way to turn it into a thread. It holds only what the two people put in the chat.
 */
export function ChatRail({
  peer,
  shared,
  complete,
  onVisit,
  onStartThread,
}: {
  readonly peer: PublicPersonRef;
  readonly shared: readonly SharedHere[];
  /**
   * Whether every message of the chat has been read. Only the newest page is loaded, so while older messages wait the
   * list is the recent ones: it carries no count and never says nothing was shared.
   */
  readonly complete: boolean;
  /** Opens the friend's universe as far as they share it; absent when the chat has ended. */
  readonly onVisit: (() => void) | undefined;
  /** Starts a thread from the newest shared card; absent when none can be started. */
  readonly onStartThread: (() => void) | undefined;
}) {
  const theme = useTalkTheme();
  const now = new Date();
  return (
    <View
      role="complementary"
      aria-label="In this chat"
      style={[styles.rail, { backgroundColor: theme.ground, borderLeftColor: theme.bar.edge }]}
      testID="chat-rail"
    >
      <Text variant="monoXs" heading={2} color={theme.textQuiet}>
        IN THIS CHAT
      </Text>
      <View style={styles.person}>
        <PersonAvatar person={peer} size={40} />
        <View style={styles.personText}>
          <Text variant="ui" color={theme.text} numberOfLines={1}>
            {peer.displayName}
          </Text>
          <Text variant="meta" color={theme.textQuiet} numberOfLines={1}>
            {`@${peer.handle}`}
          </Text>
        </View>
      </View>
      {onVisit === undefined ? null : (
        <Button
          label={`Visit ${peer.displayName}’s universe`}
          variant="space"
          size="sm"
          icon="universe"
          onPress={onVisit}
          testID="chat-rail-visit"
        />
      )}
      <View style={styles.group}>
        <Text variant="monoXs" heading={3} color={theme.textQuiet}>
          {complete ? `SHARED HERE · ${String(shared.length)}` : 'SHARED HERE'}
        </Text>
        {shared.length === 0 ? (
          <Text variant="bodyS" color={theme.textQuiet} testID="shared-here-empty">
            {complete ? 'Nothing has been shared in this chat yet.' : 'None in the recent messages.'}
          </Text>
        ) : (
          <View role="list" accessibilityLabel="Shared here" style={styles.list}>
            {shared.map((card) => (
              <View key={card.messageId} role="listitem" style={styles.card} testID={`shared-here-${card.messageId}`}>
                <Icon name={card.kind === 'reel' ? 'reel' : 'scroll'} size={20} color={content.ink} />
                <View style={styles.cardText}>
                  <Text variant="uiS" color={content.ink} numberOfLines={2}>
                    {card.title}
                  </Text>
                  <Text variant="meta" color={content.ink2} numberOfLines={1}>
                    {`${card.kind === 'reel' ? 'Reel' : 'Scroll'} · ${card.by} · ${listTime(card.at, now)}`}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
      {onStartThread === undefined ? null : (
        <View style={styles.promo} testID="chat-rail-thread">
          <Text variant="ui" color={content.ink}>
            Talking about a series?
          </Text>
          <Text variant="bodyS" color={content.ink2}>
            Start a thread from it: you’ll see who’s on which part, call it together and make what-ifs.
          </Text>
          <Button
            label="Start a thread from this"
            variant="primary"
            size="sm"
            onPress={onStartThread}
            testID="chat-rail-start-thread"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: CHAT_RAIL_WIDTH,
    padding: layout.gutter,
    gap: spacing[3],
    borderLeftWidth: borderWidth.regular,
  },
  person: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  personText: { flex: 1 },
  group: { gap: spacing[2] },
  list: { gap: spacing[2] },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    padding: spacing[2],
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  cardText: { flex: 1, gap: spacing['0.5'] },
  promo: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.md,
    backgroundColor: content.paper,
    alignItems: 'flex-start',
  },
});
