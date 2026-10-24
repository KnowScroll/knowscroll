import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { ConversationContentProjection, ConversationMessage } from '@knowscroll/contracts';
import type { OutgoingMessage } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Button, Tag, Text } from '@knowscroll/ui';

/**
 * A shared Reel or Scroll as a card. It shows only public metadata and is never playback or proof
 * that anyone watched: opening it takes the reader to the content's own page, where their own
 * encounter begins. A corrected card says so and opens the updated version; a withdrawn one stays
 * in the thread as a quiet note.
 */
export function ContentCard({
  card,
  note,
}: {
  readonly card: ConversationContentProjection;
  readonly note?: string | undefined;
}) {
  const router = useRouter();
  if (card.status === 'unavailable')
    return (
      <View style={[styles.card, styles.unavailable]}>
        <Tag variant="neutral" label="Unavailable" />
        <Text variant="bodyS">This content is no longer available.</Text>
        <Text variant="meta" color={content.ink2}>
          The message stays; the content doesn’t.
        </Text>
      </View>
    );
  const metadata = card.status === 'available' ? card.metadata : card.current.metadata;
  const word = metadata.kind === 'reel' ? 'Reel' : 'Scroll';
  const open = card.status === 'corrected' ? `Open updated ${word}` : `Open ${word}`;
  const path = `/${metadata.kind}/${card.target.assetId}`;
  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Tag variant="neutral" label={word} />
        {card.status === 'corrected' ? <Tag variant="corrected" label="Updated" /> : null}
      </View>
      <View style={styles.cardBody}>
        <Text variant="bodyS" numberOfLines={3}>
          {metadata.title}
        </Text>
        {metadata.summary === '' ? null : (
          <Text variant="meta" color={content.ink2} numberOfLines={2}>
            {metadata.summary}
          </Text>
        )}
        {note === undefined ? null : <Text variant="bodyS">{note}</Text>}
        <Button
          label={open}
          size="sm"
          role="link"
          href={path}
          onPress={() => router.push(path)}
          accessibilityHint={
            card.status === 'corrected' ? 'Opens the revised version, not the one first shared' : undefined
          }
        />
      </View>
    </View>
  );
}

/**
 * C02 and C04: the line between what the person had read and what arrived while their connection
 * was lost. It is placed, never scrolled to, so a reader higher up keeps their place.
 */
export function AwayDivider() {
  return (
    <View style={styles.away} accessibilityLiveRegion="polite" testID="away-divider">
      <View style={styles.awayRule} />
      <Text variant="monoXs" color={content.ink2}>
        WHILE YOU WERE AWAY
      </Text>
      <View style={styles.awayRule} />
    </View>
  );
}

/** The sequence of the first message under the divider, if the divider is drawn at all. */
export function firstAwayMessage(
  messages: readonly { readonly sequence: number }[],
  awayAfterSequence: number | undefined,
): number | undefined {
  return awayAfterSequence === undefined
    ? undefined
    : messages.find((message) => message.sequence > awayAfterSequence)?.sequence;
}

export function MessageBubble({ message, mine }: { readonly message: ConversationMessage; readonly mine: boolean }) {
  if (message.status === 'unavailable')
    return (
      <View style={[styles.bubble, styles.removed, mine ? styles.mine : styles.theirs]}>
        <Text variant="meta" color={content.ink2}>
          Message removed
        </Text>
      </View>
    );
  if (message.body.kind === 'content')
    return (
      <View style={mine ? styles.mine : styles.theirs}>
        <ContentCard card={message.body.content} note={message.body.note} />
      </View>
    );
  return (
    <View style={[styles.bubble, mine ? styles.mineBubble : styles.theirBubble, mine ? styles.mine : styles.theirs]}>
      <Text variant="bodyS" color={mine ? content.onAccent : content.ink} selectable>
        {message.body.text}
      </Text>
    </View>
  );
}

/** A message being sent: a single bubble that stays one bubble through every retry. */
export function OutgoingBubble({
  entry,
  onRetry,
  onDismiss,
}: {
  readonly entry: OutgoingMessage;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const failed = entry.status === 'unconfirmed' || entry.status === 'not_sent';
  return (
    <View style={styles.mine} testID="outgoing-message">
      {entry.body.kind === 'text' ? (
        <View style={[styles.bubble, failed ? styles.failedBubble : styles.mineBubble]}>
          <Text variant="bodyS" color={failed ? content.ink : content.onAccent} selectable>
            {entry.body.text}
          </Text>
        </View>
      ) : null}
      {failed ? (
        <View style={styles.failure} accessibilityLiveRegion="polite">
          <Text variant="metaS" color={status.danger.foreground}>
            {entry.status === 'unconfirmed' ? 'Not confirmed' : 'Not sent'}
          </Text>
          <Button label="Retry" size="sm" icon="retry" onPress={onRetry} />
          {entry.status === 'not_sent' ? (
            <Button label="Dismiss" size="sm" variant="ghost" onPress={onDismiss} />
          ) : null}
        </View>
      ) : (
        <Text variant="monoXs" color={content.ink2}>
          {entry.status === 'sending' ? 'Sending…' : 'Sent'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  away: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[2] },
  awayRule: { flex: 1, height: borderWidth.hairline, backgroundColor: content.ink },
  bubble: { maxWidth: '82%', borderRadius: radius.panel, paddingHorizontal: spacing[4], paddingVertical: spacing[3] },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing[1] },
  theirs: { alignSelf: 'flex-start' },
  mineBubble: { backgroundColor: content.accent },
  theirBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: content.ink },
  failedBubble: { backgroundColor: content.paper, borderWidth: borderWidth.regular, borderColor: status.danger.edge },
  removed: { backgroundColor: content.paper2, borderWidth: borderWidth.light, borderColor: content.muted },
  failure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  card: {
    width: 280,
    maxWidth: '100%',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    overflow: 'hidden',
  },
  unavailable: { borderStyle: 'dashed', borderColor: content.muted, padding: spacing[4], gap: spacing[2] },
  cardTop: {
    flexDirection: 'row',
    gap: spacing[2],
    padding: spacing[3],
    backgroundColor: content.accent,
    minHeight: 56,
    alignItems: 'flex-start',
  },
  cardBody: { padding: spacing[4], gap: spacing[2], alignItems: 'flex-start' },
});
