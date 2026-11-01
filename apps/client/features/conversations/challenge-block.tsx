import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  challengeNoticeWords,
  challengeRevealWords,
  challengeStatusWords,
  optionLetter,
} from '@knowscroll/client-core';
import type { ChallengeCard } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status, target, universe } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing } from '@knowscroll/ui';

type Revealed = Extract<ChallengeCard, { stage: 'revealed' }>;

/**
 * Challenge a friend, inside a shared Scroll's card (D-244, D-245): the question of one of the Scroll's calls, which each
 * of the two people answers on their own. Nothing here shows the friend's pick or the right answer before the person has
 * called: the card is given only what its stage may show (the contract carries the rest only once both have called). A
 * right call is a spark, a wrong one a plot twist, never a loss, and nothing ranks anyone. A pick is saved only while
 * recording is on (D-083): while it is paused the card says so at once and its Lock stays off, and the `notice` says why
 * the last attempt did not keep a pick.
 */
export function ChallengeBlock({
  challenge,
  friend,
  notice,
  recordingPaused = false,
  locking,
  onLock,
}: {
  readonly challenge: ChallengeCard;
  /** The other person's first name or display name, for the words. */
  readonly friend: string;
  readonly notice: 'paused' | 'failed' | undefined;
  /** Recording is paused on this device, so no call can be locked in until it is on. */
  readonly recordingPaused?: boolean;
  readonly locking: boolean;
  readonly onLock: (option: number) => void;
}) {
  const [picked, setPicked] = useState<number>();
  const open = challenge.stage === 'open';
  const revealed = challenge.stage === 'revealed';
  const words = revealed ? challengeRevealWords(challenge) : undefined;
  const lock = () => {
    if (picked !== undefined && !locking) onLock(picked);
  };
  return (
    <View role="region" aria-label="Challenge" style={styles.block} testID="challenge-block">
      <View
        style={[styles.band, { backgroundColor: revealed && !challenge.right ? status.danger.fill : universe.focus }]}
      >
        <Text
          variant="monoXs"
          color={revealed && !challenge.right ? universe.paper : content.ink}
          style={styles.bandText}
        >
          {words === undefined ? 'CHALLENGE · CALL IT FIRST' : `${words.title.toUpperCase()} · REVEALED`}
        </Text>
        {words?.spark === undefined ? null : (
          <Text variant="monoXs" color={content.ink} testID="challenge-spark">
            {`★ ${words.spark}`}
          </Text>
        )}
      </View>
      <View style={styles.body}>
        <Text variant="ui" heading={3} testID="challenge-prompt">
          {challenge.prompt}
        </Text>
        <View role={open ? 'radiogroup' : 'list'} accessibilityLabel={challenge.prompt} style={styles.options}>
          {challenge.options.map((text, option) =>
            open ? (
              <PickOption
                key={option}
                option={option}
                text={text}
                checked={picked === option}
                disabled={locking}
                onPick={() => setPicked(option)}
              />
            ) : (
              <SeenOption key={option} challenge={challenge} option={option} text={text} friend={friend} />
            ),
          )}
        </View>
        <Text variant="metaS" color={content.ink2} testID="challenge-status">
          {challengeStatusWords(challenge, friend)}
        </Text>
        {revealed ? <RevealedWords challenge={challenge} /> : null}
        {notice === undefined && !(open && recordingPaused) ? null : <LockNotice reason={notice ?? 'paused'} />}
        {open ? (
          <Button
            label="Lock it in"
            variant="ink"
            fullWidth
            busy={locking}
            busyLabel="Locking"
            disabled={picked === undefined || recordingPaused}
            onPress={lock}
            testID="challenge-lock"
          />
        ) : null}
      </View>
    </View>
  );
}

function LockNotice({ reason }: { readonly reason: 'paused' | 'failed' }) {
  const words = challengeNoticeWords(reason);
  return reason === 'paused' ? (
    <Banner kind="recordingPaused" lead={words.lead} message={words.message} testID="challenge-notice" />
  ) : (
    <Banner kind="error" lead={words.lead} message={words.message} testID="challenge-notice" />
  );
}

function PickOption({
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
      aria-disabled={disabled}
      accessibilityLabel={`Option ${optionLetter(option)}. ${text}`}
      disabled={disabled}
      onPress={onPick}
      style={[styles.option, checked ? styles.optionPicked : null, focus.style]}
      testID={`challenge-option-${String(option)}`}
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

/** One option once the person has called: their own pick marked, and after the reveal the right answer and the friend's pick. */
function SeenOption({
  challenge,
  option,
  text,
  friend,
}: {
  readonly challenge: Exclude<ChallengeCard, { stage: 'open' }>;
  readonly option: number;
  readonly text: string;
  readonly friend: string;
}) {
  const mine = challenge.option === option;
  const reveal: Revealed | undefined = challenge.stage === 'revealed' ? challenge : undefined;
  const isAnswer = reveal?.answer === option;
  const theirs = reveal?.theirs === option;
  const label = [
    `Option ${optionLetter(option)}. ${text}.`,
    mine ? 'Your call.' : undefined,
    theirs ? `${friend}’s call.` : undefined,
    isAnswer ? 'Right answer.' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <View
      role="listitem"
      accessibilityLabel={label}
      style={[styles.option, mine ? styles.optionPicked : null, isAnswer ? styles.optionRight : null]}
      testID={`challenge-seen-${String(option)}`}
    >
      <View style={styles.letter} aria-hidden>
        <Text variant="monoXs" color={content.ink2}>
          {optionLetter(option)}
        </Text>
      </View>
      <View style={styles.optionBody} aria-hidden>
        <Text variant="uiS">{text}</Text>
        {mine || theirs ? (
          // Under the words, so that two names and a tick cannot squeeze the option into a column one word wide.
          <View style={styles.calls}>
            {mine ? (
              <Text variant="monoXs" color={content.ink2}>
                YOU
              </Text>
            ) : null}
            {theirs ? (
              <Text variant="monoXs" color={content.ink2}>
                {friend.toUpperCase()}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {isAnswer ? <Icon name="check" size={18} color={content.ink} /> : null}
    </View>
  );
}

function RevealedWords({ challenge }: { readonly challenge: Revealed }) {
  return (
    <>
      <Text variant="meta" testID="challenge-explain">
        {challenge.explain}
      </Text>
      {challenge.twist === undefined ? null : (
        <Text variant="meta" color={content.ink2} testID="challenge-twist">
          {challenge.twist}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  block: { borderTopWidth: borderWidth.hairline, borderTopColor: 'rgba(21,48,42,0.16)' },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    minHeight: target.minimum,
  },
  bandText: { flex: 1 },
  body: { gap: spacing[3], padding: spacing[4] },
  options: { gap: spacing[2] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: target.minimum + spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.hairline,
    borderColor: 'rgba(21,48,42,0.16)',
    borderRadius: radius.md,
    backgroundColor: universe.paper,
  },
  optionPicked: { borderWidth: borderWidth.regular, borderColor: universe.ink, backgroundColor: universe.paper2 },
  optionRight: {
    borderWidth: borderWidth.regular,
    borderColor: universe.fresh,
    backgroundColor: 'rgba(20,199,155,0.14)',
  },
  optionText: { flex: 1 },
  optionBody: { flex: 1, gap: spacing[1] },
  calls: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing[3] },
  letter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: universe.paper2,
  },
});
