import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { threadRowView, threadsHolding, type AccountScope, type ThreadsHolding } from '@knowscroll/client-core';
import type { ContentThreadRef, ThreadSummary } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Text, useFocusRing, useTypeStyle } from '@knowscroll/ui';
import { momentAnchorOf, momentOf, whyNoMoment, type NoMoment } from '@knowscroll/scroll-model';
import { newCommandId } from '../../platform/command-id';
import { useAccountScope } from '../../providers/account-scope';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { useSnippetSend } from './use-snippet-send';
import { useThreadInbox } from './use-thread-inbox';

/** Why a stop is not offered as a moment, in the words shown next to the disabled row and in the sheet. */
export function noMomentWords(reason: NoMoment): string {
  switch (reason) {
    case 'call':
      return 'A call would give its answer away, so it can’t be shared as a moment. Challenge a friend sends it without one.';
    case 'too_long':
      return 'This stop is too long to share as a moment.';
    case 'no_stop':
      return 'A moment is one stop. Go to a stop to share it.';
  }
}

/** A thread a moment is shared into: the person's own reference to it and the name they know it by. */
export interface MomentThread {
  readonly ref: ContentThreadRef;
  readonly name: string;
}

/**
 * Which of the person's joined threads hold this Scroll. A snippet may only point into its own thread's series, so a thread
 * about something else cannot take a moment; the inbox does not say what a thread holds, so each is asked once.
 */
function useHolding(scope: AccountScope, items: readonly ThreadSummary[], assetId: string, ready: boolean) {
  const [holding, setHolding] = useState<ThreadsHolding | undefined>();
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  });
  const joinedKey = items
    .filter((item) => item.state === 'joined')
    .map((item) => item.thread.threadId)
    .join(',');
  useEffect(() => {
    if (!ready) return undefined;
    let stopped = false;
    void threadsHolding(scope, newCommandId, latest.current, assetId).then((found) => {
      if (!stopped) setHolding(found);
    });
    return () => {
      stopped = true;
    };
  }, [scope, assetId, ready, joinedKey]);
  return holding;
}

function ThreadChoice({
  scope,
  assetId,
  onChoose,
}: {
  readonly scope: AccountScope;
  readonly assetId: string;
  readonly onChoose: (thread: MomentThread) => void;
}) {
  const inbox = useThreadInbox(scope);
  const focus = useFocusRing('onLight');
  const holding = useHolding(scope, inbox.items, assetId, !inbox.loading && !inbox.failed);
  if (inbox.loading || (!inbox.failed && holding === undefined))
    return <Skeleton rows={2} label="Looking for your threads about this Scroll" />;
  if (inbox.failed)
    return (
      <View style={styles.step}>
        <Banner kind="offline" lead="Couldn’t load your threads." message="Check your connection and try again." />
        <Button label="Try again" size="sm" variant="ghost" onPress={inbox.retry} />
      </View>
    );
  const threads = holding?.threads ?? [];
  if (threads.length === 0)
    return (
      <View style={styles.step} testID="moment-no-threads">
        <Text variant="bodyS">
          None of your threads holds this Scroll. A moment can only go into a thread about this Scroll or its series.
          Start one from Share, Explore with friends.
        </Text>
        {holding !== undefined && holding.unchecked > 0 ? (
          <Text variant="meta" color={content.ink2}>
            {holding.unchecked === 1
              ? 'One of your threads could not be checked.'
              : `${String(holding.unchecked)} of your threads could not be checked.`}
          </Text>
        ) : null}
      </View>
    );
  return (
    <View style={styles.step}>
      <Text variant="uiS">Share into a thread</Text>
      {threads.map((item) => {
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
      {send.status === 'invalid' ? (
        <Banner
          kind="error"
          lead="This thread can’t take it."
          message="Nothing was sent. It doesn’t hold this Scroll, or this stop can’t be shared as a moment."
        />
      ) : null}
      {send.status === 'unavailable' ? (
        <Banner
          kind="error"
          lead="Couldn’t share this."
          message="Nothing was sent. The Scroll may have been updated."
        />
      ) : null}
      {send.status === 'failed' ? (
        <Banner kind="error" lead="Couldn’t share this right now." message="Nothing was sent. Try again in a moment." />
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
  const reason = whyNoMoment(scroll.document, stopId);
  if (stopId === undefined || reason !== undefined)
    return (
      <View style={styles.step}>
        <Text variant="bodyS" testID="moment-not-shareable">
          {noMomentWords(reason ?? 'no_stop')}
        </Text>
        <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
      </View>
    );
  return chosen === undefined ? (
    <ThreadChoice scope={state.scope} assetId={scroll.assetId} onChoose={setChosen} />
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
