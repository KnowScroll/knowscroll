import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import type { ConversationContentProjection } from '@knowscroll/contracts';
import type { OutgoingMessage } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing, universe } from '@knowscroll/design-tokens';
import { Button, TalkBubble, Tag, Text, useTalkTheme } from '@knowscroll/ui';

/**
 * A shared Reel or Scroll as a card (T3 kit: paper, a chunky shadow). It shows only public metadata and
 * is never playback or proof that anyone watched: opening it takes the reader to the content's own page,
 * where their own encounter begins. "Watch together" turns the conversation into a thread with the same
 * two people; it too starts nothing for either of them. A corrected card says so and opens the updated
 * version; a withdrawn one stays in the thread as a quiet note.
 */
export function ContentCard({
  card,
  note,
  onWatchTogether,
}: {
  readonly card: ConversationContentProjection;
  readonly note?: string | undefined;
  /** Starts a thread about this card with the other person; absent when none can be started. */
  readonly onWatchTogether?: (() => void) | undefined;
}) {
  const router = useRouter();
  if (card.status === 'unavailable')
    return (
      <View style={[styles.card, styles.unavailable]}>
        <Tag variant="neutral" label="Unavailable" />
        <Text variant="bodyS" color={universe.ink}>
          This content is no longer available.
        </Text>
        <Text variant="meta" color={universe.ink2}>
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
        <Text variant="bodyS" color={universe.ink} numberOfLines={3}>
          {metadata.title}
        </Text>
        {metadata.summary === '' ? null : (
          <Text variant="meta" color={universe.ink2} numberOfLines={2}>
            {metadata.summary}
          </Text>
        )}
        {note === undefined ? null : (
          <Text variant="bodyS" color={universe.ink}>
            {note}
          </Text>
        )}
        <View style={styles.cardActions}>
          <Button
            label={open}
            size="sm"
            variant="ink"
            role="link"
            href={path}
            onPress={() => router.push(path)}
            accessibilityHint={
              card.status === 'corrected' ? 'Opens the revised version, not the one first shared' : undefined
            }
          />
          {onWatchTogether === undefined ? null : (
            <Button
              label="Watch together"
              size="sm"
              accessibilityHint="Starts a thread about this with the same person"
              onPress={onWatchTogether}
              testID="watch-together"
            />
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * C02 and C04: the line between what the person had read and what arrived while their connection
 * was lost. It is placed, never scrolled to, so a reader higher up keeps their place.
 */
export function AwayDivider() {
  const theme = useTalkTheme();
  return (
    <View style={styles.away} accessibilityLiveRegion="polite" testID="away-divider">
      <View style={[styles.awayRule, { backgroundColor: theme.textQuiet }]} />
      <Text variant="monoXs" color={theme.textQuiet}>
        WHILE YOU WERE AWAY
      </Text>
      <View style={[styles.awayRule, { backgroundColor: theme.textQuiet }]} />
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

/** A message that was removed keeps its place as a quiet note: nothing of what it said, and nothing of who. */
export function RemovedMessage({ mine }: { readonly mine: boolean }) {
  const theme = useTalkTheme();
  return (
    <View
      style={[
        styles.removed,
        mine ? styles.mine : styles.theirs,
        { backgroundColor: theme.capsule.fill, borderColor: theme.capsule.edge },
      ]}
    >
      <Text variant="meta" color={theme.capsule.text}>
        Message removed
      </Text>
    </View>
  );
}

/** A message the person is sending: one bubble through every retry, a quiet word under it, and the way out of a failure. */
export function OutgoingBubble({
  entry,
  onRetry,
  onDismiss,
  onSendWithoutQuote,
}: {
  readonly entry: OutgoingMessage;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
  /** Sends a refused reply as a plain message: its original was removed, so it can never be sent with the quote. */
  readonly onSendWithoutQuote: () => void;
}) {
  const theme = useTalkTheme();
  const failed = entry.status === 'unconfirmed' || entry.status === 'not_sent';
  return (
    <View style={styles.mine} testID="outgoing-message">
      {entry.body.kind === 'text' ? (
        <View style={failed ? null : styles.sending}>
          <TalkBubble mine tail failed={failed}>
            <Text variant="bubble" color={failed ? theme.bubbleOther.text : theme.bubbleOwn.text} selectable>
              {entry.body.text}
            </Text>
          </TalkBubble>
        </View>
      ) : null}
      {failed ? (
        <View style={styles.failure} accessibilityLiveRegion="polite">
          <Text variant="metaS" color={theme.text}>
            {entry.status === 'unconfirmed' ? 'Not confirmed' : 'Not sent'}
          </Text>
          <Button label="Retry" size="sm" icon="retry" variant="space" onPress={onRetry} />
          {entry.status === 'not_sent' ? (
            <>
              {entry.replyTo === undefined ? null : (
                <Button
                  label="Send without the quote"
                  size="sm"
                  variant="space"
                  accessibilityHint="The message you answered was removed"
                  onPress={onSendWithoutQuote}
                />
              )}
              <Button label="Dismiss" size="sm" variant="space" onPress={onDismiss} />
            </>
          ) : null}
        </View>
      ) : (
        <Text variant="monoXs" color={theme.textQuiet}>
          {entry.status === 'sending' ? 'Sending…' : 'Sent'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  away: { flexDirection: 'row', alignItems: 'center', gap: spacing[3], paddingVertical: spacing[2] },
  awayRule: { flex: 1, height: borderWidth.hairline },
  mine: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: spacing[1] },
  theirs: { alignSelf: 'flex-start' },
  sending: { opacity: 0.8 },
  removed: {
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
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
    borderRadius: 22,
    backgroundColor: universe.paper,
    boxShadow: universe.shadow.card,
    overflow: 'hidden',
  },
  unavailable: {
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.muted,
    padding: spacing[4],
    gap: spacing[2],
  },
  cardTop: {
    flexDirection: 'row',
    gap: spacing[2],
    padding: spacing[3],
    backgroundColor: universe.orange,
    minHeight: 48,
    alignItems: 'flex-start',
  },
  cardBody: { padding: spacing[4], gap: spacing[2], alignItems: 'flex-start' },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
