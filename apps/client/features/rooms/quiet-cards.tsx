import { StyleSheet, View } from 'react-native';
import { questionReplyLine } from '@knowscroll/client-core';
import type { LaunchHost, QuestionReply } from '@knowscroll/contracts';
import { borderWidth, content, elevation, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { HostMark } from './launch-stage';

/**
 * A person answered a question the member left (R3 F frame 4): who, and how long it took, from the server's own facts. It names the
 * person and nothing else about them, and is gone once the member opens the answer or says they saw it. In the room only: no push
 * exists, and nothing here claims anyone is online.
 */
export function QuestionReplyCard({
  reply,
  busy,
  onRead,
  onDismiss,
}: {
  readonly reply: QuestionReply;
  readonly busy: boolean;
  readonly onRead: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <View
      style={styles.reply}
      testID={`question-reply-${reply.discussionId}`}
      role="region"
      accessibilityLabel="A person answered your question"
    >
      <Text variant="ui" testID="question-reply-line">
        {questionReplyLine(reply)}
      </Text>
      <Text variant="bodyS" color={content.ink2} numberOfLines={2}>
        {reply.title}
      </Text>
      <View style={styles.actions}>
        <Button label="Read it" size="sm" variant="primary" busy={busy} onPress={onRead} testID="question-reply-read" />
        <Button
          label="Got it"
          size="sm"
          variant="ghost"
          busy={busy}
          onPress={onDismiss}
          testID="question-reply-dismiss"
        />
      </View>
    </View>
  );
}

/**
 * The quiet room's offer (R3 F frame 1), from the Launch's host and labelled AI: a real Launch can be played again. It is a card, not
 * a message: it is made on this device from what the server read, costs no model call, is not a turn of any resident and says nothing
 * of people who are not here. "Not now" puts it away for this visit.
 */
export function QuietOfferCard({
  host,
  line,
  onReplay,
  onDismiss,
}: {
  readonly host: Pick<LaunchHost, 'name' | 'label'>;
  readonly line: string;
  readonly onReplay: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <View style={styles.offer} testID="quiet-offer" role="region" accessibilityLabel="A warm-up offered by the host">
      <View style={styles.head}>
        <HostMark />
        <Text variant="ui">{host.name}</Text>
        <AiLabel label={host.label} testID="quiet-offer-label" />
      </View>
      <Text variant="bodyS" testID="quiet-offer-line">
        {line}
      </Text>
      <View style={styles.actions}>
        <Button label="Warm me up" size="sm" variant="primary" onPress={onReplay} testID="quiet-offer-replay" />
        <Button label="Not now" size="sm" variant="ghost" onPress={onDismiss} testID="quiet-offer-dismiss" />
      </View>
    </View>
  );
}

const card = {
  gap: spacing[2],
  padding: spacing[3],
  marginHorizontal: layout.gutter,
  marginVertical: spacing[2],
  borderWidth: borderWidth.regular,
  borderColor: content.ink,
  borderRadius: radius.card,
  backgroundColor: content.paper,
} as const;

const styles = StyleSheet.create({
  reply: { ...card, backgroundColor: content.paper, boxShadow: elevation.raised },
  offer: { ...card, borderStyle: 'dotted', borderTopLeftRadius: radius.xs, alignItems: 'flex-start' },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[2] },
});
