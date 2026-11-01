import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { threadRowView, type AccountScope } from '@knowscroll/client-core';
import type { ContentThreadRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Text, useFocusRing, useTypeStyle } from '@knowscroll/ui';
import { momentAnchorOf, momentOf } from '@knowscroll/scroll-model';
import { useAccountScope } from '../../providers/account-scope';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { useSnippetSend } from './use-snippet-send';
import { useThreadInbox } from './use-thread-inbox';

/** A thread a moment is shared into: the person's own reference to it and the name they know it by. */
export interface MomentThread {
  readonly ref: ContentThreadRef;
  readonly name: string;
}

function ThreadChoice({
  scope,
  onChoose,
}: {
  readonly scope: AccountScope;
  readonly onChoose: (thread: MomentThread) => void;
}) {
  const inbox = useThreadInbox(scope);
  const focus = useFocusRing('onLight');
  const joined = inbox.items.filter((item) => item.state !== 'invited');
  if (inbox.loading) return <Skeleton rows={2} label="Loading your threads" />;
  if (inbox.failed)
    return (
      <View style={styles.step}>
        <Banner kind="offline" lead="Couldn’t load your threads." message="Check your connection and try again." />
        <Button label="Try again" size="sm" variant="ghost" onPress={inbox.retry} />
      </View>
    );
  if (joined.length === 0)
    return (
      <Text variant="bodyS" testID="moment-no-threads">
        You have no threads yet. Start one from Share, Explore with friends, and share a moment into it.
      </Text>
    );
  return (
    <View style={styles.step}>
      <Text variant="uiS">Share into a thread</Text>
      {joined.map((item) => {
        const row = threadRowView(item);
        return (
          <Pressable
            key={item.thread.threadId}
            {...focus.props}
            role="button"
            accessibilityLabel={row.title}
            onPress={() => onChoose({ ref: item.thread, name: row.title })}
            style={[styles.choice, focus.style]}
            testID="moment-thread"
          >
            <Text variant="uiS" numberOfLines={2}>
              {row.title}
            </Text>
            <Text variant="meta" color={content.ink2} numberOfLines={1}>
              {row.subtitle}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SendMoment({
  scope,
  scroll,
  stopId,
  thread,
  onClose,
}: {
  readonly scope: AccountScope;
  readonly scroll: OpenedStageScroll;
  readonly stopId: string;
  readonly thread: MomentThread;
  readonly onClose: () => void;
}) {
  const moment = momentOf(scroll.document, stopId);
  const send = useSnippetSend(scope, thread.ref);
  const [note, setNote] = useState('');
  const type = useTypeStyle('bodyS');
  if (moment === undefined) return null;
  if (send.status === 'sent')
    return (
      <View style={styles.step} accessibilityLiveRegion="polite">
        <Banner kind="info" lead="Shared." message={`Your friends can open it from ${thread.name}.`} />
        <Button label="Done" variant="primary" fullWidth onPress={onClose} testID="moment-done" />
      </View>
    );
  const sending = send.status === 'sending';
  return (
    <View style={styles.step}>
      <Text variant="monoXs" color={content.ink2}>
        This stop · {scroll.document.title}
      </Text>
      <Text variant="bodyS" style={styles.quote} testID="moment-quote">
        “{moment.quote}”
      </Text>
      <View style={styles.field}>
        <Text variant="uiS">Message (optional)</Text>
        <TextInput
          accessibilityLabel="Message (optional)"
          value={note}
          onChangeText={setNote}
          maxLength={500}
          allowFontScaling={false}
          style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
        />
      </View>
      <Text variant="monoXs" color={content.ink2}>
        To · {thread.name}
      </Text>
      {send.status === 'unconfirmed' ? (
        <Banner
          kind="error"
          lead="Couldn’t confirm it was shared."
          message="Sharing again sends the same message, so it can’t arrive twice."
        />
      ) : null}
      {send.status === 'unavailable' || send.status === 'invalid' || send.status === 'failed' ? (
        <Banner
          kind="error"
          lead="Couldn’t share this."
          message="Nothing was sent. The Scroll may have been updated."
        />
      ) : null}
      <Button
        label={send.status === 'unconfirmed' ? 'Share again' : 'Share this moment'}
        icon="share"
        variant="primary"
        fullWidth
        busy={sending}
        busyLabel="Sharing"
        onPress={() => {
          const trimmed = note.trim();
          void send.send({
            kind: 'snippet',
            target: { assetId: scroll.assetId, assetRevision: scroll.assetRevision },
            anchor: momentAnchorOf(moment),
            ...(trimmed === '' ? {} : { note: trimmed }),
          });
        }}
        testID="moment-share"
      />
    </View>
  );
}

/**
 * Share a moment (V3 G5 "Share a moment: this stop, with its picture", D-292, D-293): the read stop on screen, sent into a
 * thread as a snippet. The message carries the exact revision and an anchor with a hash of the stop's words, never the words
 * themselves; the card's quote is read from the revision. Inside a thread the thread is known; anywhere else the person
 * chooses one of theirs. Sharing is not reading and records nothing about the person's reading.
 */
export function ShareStopSheet({
  scroll,
  stopId,
  thread,
  onClose,
}: {
  readonly scroll: OpenedStageScroll;
  /** The stop on screen when the sheet opened. */
  readonly stopId: string | undefined;
  /** The thread the Scroll is being read in, when it is read in one. */
  readonly thread?: MomentThread | undefined;
  readonly onClose: () => void;
}) {
  const { state } = useAccountScope();
  const [chosen, setChosen] = useState<MomentThread | undefined>(thread);
  if (state.status !== 'signed_in') return null;
  if (stopId === undefined || momentOf(scroll.document, stopId) === undefined)
    return (
      <View style={styles.step}>
        <Text variant="bodyS">Only a reading stop can be shared as a moment. A call can be sent as a challenge.</Text>
        <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
      </View>
    );
  return chosen === undefined ? (
    <ThreadChoice scope={state.scope} onChoose={setChosen} />
  ) : (
    <SendMoment scope={state.scope} scroll={scroll} stopId={stopId} thread={chosen} onClose={onClose} />
  );
}

const styles = StyleSheet.create({
  step: { gap: spacing[3] },
  choice: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  quote: { fontStyle: 'italic' },
  field: { gap: spacing[1] },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
});
