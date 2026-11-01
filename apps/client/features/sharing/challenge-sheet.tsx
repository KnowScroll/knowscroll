import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { optionLetter, type AccountScope, type SendStatus } from '@knowscroll/client-core';
import type { DirectConversationRef } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, target as targetSize } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing } from '@knowscroll/ui';
import { afterPendingBack, notePendingBack } from '../../platform/after-pending-back';
import { appApiOrigin } from '../../platform/api';
import { useAccountScope } from '../../providers/account-scope';
import { conversationHref } from '../conversations/conversation-links';
import { useSheetAvailability } from '../friends/use-availability';
import type { OpenedStageScroll } from '../scroll/scroll-session';
import { challengeCallOf, type ChallengeCall } from './challenge-call';
import { FriendPicker } from './friend-picker';
import { GroupLabel } from './step-header';
import { useShareSession } from './use-share-session';

/** One option of the call the sender answers first: a radio picked by press. */
function CallOption({
  option,
  text,
  checked,
  disabled,
  onPick,
}: {
  readonly option: number;
  readonly text: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      role="radio"
      aria-checked={checked}
      accessibilityLabel={`Option ${optionLetter(option)}. ${text}`}
      disabled={disabled}
      onPress={onPick}
      style={[styles.option, checked ? styles.optionPicked : null, focus.style]}
      testID={`challenge-pick-${String(option)}`}
    >
      <View style={styles.letter} aria-hidden>
        <Text variant="monoXs" color={content.ink2}>
          {optionLetter(option)}
        </Text>
      </View>
      <Text variant="uiS" style={styles.optionText}>
        {text}
      </Text>
      {checked ? <Icon name="check" size={18} color={content.ink} /> : null}
    </Pressable>
  );
}

function SendNotice({ send }: { readonly send: SendStatus }) {
  if (send.status === 'unconfirmed')
    return (
      <Banner
        kind="error"
        lead="Couldn’t confirm it was sent."
        message="Retrying sends the same challenge, so it can’t arrive twice."
      />
    );
  if (send.status === 'unavailable')
    return (
      <Banner kind="error" lead="This can’t be sent right now." message="Choose someone else or try again later." />
    );
  if (send.status === 'failed')
    return <Banner kind="error" lead="Couldn’t send." message="Nothing was sent. Try again." />;
  return null;
}

/** What happened to the sender's own call after the card went: kept, or why it was not. */
function PickReceipt({ pick }: { readonly pick: 'kept' | 'paused' | 'not_kept' | undefined }) {
  if (pick === 'kept')
    return (
      <Text variant="meta" color={content.ink2}>
        Your call is locked in and hidden. You will both see the answers once you have both called.
      </Text>
    );
  if (pick === 'paused')
    return (
      <Banner
        kind="recordingPaused"
        lead="Recording is paused."
        message="The challenge went, but your own call was not saved. Open the chat to call it once recording is on."
      />
    );
  if (pick === 'not_kept')
    return (
      <Banner
        kind="error"
        lead="Your call didn’t get through."
        message="The challenge went. Open the chat to lock your call in."
      />
    );
  return null;
}

/**
 * Challenge a friend (V3 "Challenge a friend", D-244, D-245), the sheet the reader opens from the end of a Scroll or its
 * ••• menu: the Scroll's call (its Final call, else its first Call it), the sender's own call on it, and a friend to send it
 * to. The card goes into a direct conversation; the sender's pick is locked after it is sent and stays hidden from the friend
 * until they have called too. Sending a challenge is not an encounter and creates no evidence for either person. The
 * right answer is never on the device's way out: the command names the stop and nothing else.
 */
export function ChallengeSheetBody({
  scope,
  scroll,
  call,
  origin,
  onClose,
  onOpenConversation,
}: {
  readonly scope: AccountScope;
  readonly scroll: Pick<OpenedStageScroll, 'assetId' | 'assetRevision'>;
  readonly call: ChallengeCall;
  readonly origin: string;
  readonly onClose: () => void;
  readonly onOpenConversation: (conversation: DirectConversationRef) => void;
}) {
  const target = { assetId: scroll.assetId, assetRevision: scroll.assetRevision };
  const { session, state } = useShareSession(scope, target, origin, { stopId: call.stopId });
  const availabilityOf = useSheetAvailability(scope, true);
  useEffect(() => {
    if (state.targets.status === 'loading' && state.targets.items.length === 0) void session.loadTargets();
  }, [session, state.targets.status, state.targets.items.length]);
  const { send } = state;
  const chosen = state.targets.items.find((entry) => entry.person.personId === state.selected);
  const sending = send.status === 'sending';
  const locked = sending || send.status === 'unconfirmed' || send.status === 'sent';
  if (send.status === 'sent')
    return (
      <View style={styles.sheet} accessibilityLiveRegion="polite">
        <View style={styles.sent}>
          <Icon name="check" size={18} color={content.freshInk} />
          <Text variant="ui">{`Challenge sent to ${send.target.person.displayName}`}</Text>
        </View>
        <PickReceipt pick={send.pick} />
        <Button label="Open chat" size="sm" onPress={() => onOpenConversation(send.conversation)} />
        <Button label="Done" fullWidth variant="ghost" onPress={onClose} />
      </View>
    );
  return (
    <View style={styles.sheet}>
      <GroupLabel>YOUR CALL FIRST</GroupLabel>
      <Text variant="ui" heading={3} testID="challenge-sheet-prompt">
        {call.prompt}
      </Text>
      <View role="radiogroup" accessibilityLabel={call.prompt} style={styles.options}>
        {call.options.map((text, option) => (
          <CallOption
            key={option}
            option={option}
            text={text}
            checked={state.pick === option}
            disabled={locked}
            onPick={() => session.setPick(option)}
          />
        ))}
      </View>
      <Text variant="metaS" color={content.ink2}>
        Your call stays hidden from your friend until they have called too, and theirs from you.
      </Text>
      <FriendPicker
        targets={state.targets}
        selected={state.selected}
        locked={locked}
        onSelect={session.select}
        availabilityOf={availabilityOf}
      />
      <SendNotice send={send} />
      <Button
        label={
          send.status === 'unconfirmed'
            ? 'Retry'
            : chosen === undefined
              ? 'Choose a friend'
              : `Challenge ${chosen.person.displayName}`
        }
        variant="primary"
        fullWidth
        busy={sending}
        busyLabel="Sending"
        disabled={chosen === undefined || state.pick === undefined}
        onPress={() => void session.send()}
        testID="challenge-send"
      />
      <Button label="Cancel" fullWidth variant="ghost" onPress={onClose} />
    </View>
  );
}

/**
 * The sheet's content for a Scroll on screen: nothing to show for a Scroll with no call to ask, or without a signed-in
 * person, and a plain note where the app has no API address.
 */
export function ChallengeSheet({
  scroll,
  onClose,
}: {
  readonly scroll: OpenedStageScroll;
  readonly onClose: () => void;
}): ReactNode {
  const router = useRouter();
  const { state } = useAccountScope();
  const origin = appApiOrigin();
  const call = challengeCallOf(scroll.document);
  if (call === undefined) return <Text variant="bodyS">This Scroll has no question to challenge with.</Text>;
  if (state.status !== 'signed_in') return <Text variant="bodyS">Sign in to challenge a friend.</Text>;
  if (!origin.ok) return <Text variant="bodyS">Challenging a friend isn’t available right now.</Text>;
  return (
    <ChallengeSheetBody
      scope={state.scope}
      scroll={scroll}
      call={call}
      origin={origin.baseUrl}
      onClose={onClose}
      onOpenConversation={(conversation) => {
        // The sheet is a transient history entry on the web: its Back must land before the conversation opens, or it is popped.
        notePendingBack();
        onClose();
        afterPendingBack(() => router.navigate(conversationHref(conversation)));
      }}
    />
  );
}

const styles = StyleSheet.create({
  sheet: { gap: spacing[3] },
  sent: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  options: { gap: spacing[2] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: targetSize.minimum + spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.hairline,
    borderColor: content.rule,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  optionPicked: { borderWidth: borderWidth.regular, borderColor: content.ink, backgroundColor: content.paper2 },
  optionText: { flex: 1 },
  letter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: content.paper2,
  },
});
