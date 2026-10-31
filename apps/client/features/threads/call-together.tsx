import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  callChipWords,
  callPartLabel,
  callSummaryWords,
  callUpdateWords,
  joinNames,
  optionLetter,
  revealWords,
} from '@knowscroll/client-core';
import type { ThreadCall, ThreadCallPick } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status, target, universe } from '@knowscroll/design-tokens';
import { Banner, Button, Icon, Text, useFocusRing } from '@knowscroll/ui';
import { PersonAvatar } from '../conversations/person-avatar';

/**
 * "Call it together" (T3 frames 4 and 5, D-155): before a part whose Scroll has an authored question, each member
 * locks a guess. Nothing here shows another member's pick until the person has locked their own and the party has
 * finished the part; a stage that must not show it is not given it (the contract carries picks only once revealed).
 * A right call is a spark, a wrong one a plot twist, never a loss, and nothing here ranks anyone.
 */

const FACE = 22;

type Revealed = Extract<ThreadCall, { stage: 'revealed' }>;

/** Who picked an option, for a screen reader: "Called by you and Ravi." Nothing when nobody did. */
function calledBy(picks: readonly ThreadCallPick[], option: number): string | undefined {
  const names = picks
    .filter((pick) => pick.option === option)
    .map((pick) => (pick.you ? 'you' : pick.person.displayName));
  return names.length === 0 ? undefined : `Called by ${joinNames(names)}.`;
}

/** The notice under a card that could not keep the person's pick, in the person's words. */
function LockNotice({ reason }: { readonly reason: 'paused' | 'failed' | 'changed' }) {
  if (reason === 'changed')
    return (
      <Banner
        kind="info"
        lead="This call changed."
        message="The question was updated while you were choosing, so nothing was locked. Read it again and choose."
        testID="call-notice"
      />
    );
  return reason === 'paused' ? (
    <Banner
      kind="recordingPaused"
      lead="Recording is paused."
      message="A call here is saved for your thread, so it needs recording on. Turn it on in Privacy to lock it in."
      testID="call-notice"
    />
  ) : (
    <Banner kind="error" lead="Couldn’t lock it in." message="Nothing was saved. Try again." testID="call-notice" />
  );
}

/** One option of a call the person may still pick: a radio in a group, picked by press or by its number key. */
function PickOption({
  option,
  text,
  checked,
  disabled,
  onPick,
  onEnter,
}: {
  readonly option: number;
  readonly text: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onPick: () => void;
  /** Enter on the option that is already chosen locks it (T3). A press handler takes Enter before the card sees it. */
  readonly onEnter: () => void;
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
      onKeyDown={(event: { nativeEvent?: { key?: string } }) => {
        if (event.nativeEvent?.key === 'Enter' && checked) onEnter();
      }}
      style={[styles.option, checked ? styles.optionPicked : null, focus.style]}
      testID={`call-option-${String(option)}`}
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

/** The faces of the members who picked one option, after the reveal: initials, and the person's own ringed. */
function Callers({ picks }: { readonly picks: readonly ThreadCallPick[] }) {
  if (picks.length === 0) return null;
  return (
    <View style={styles.callers} aria-hidden testID="call-callers">
      {picks.map((pick) => (
        <View key={pick.person.personId} style={pick.you ? styles.you : null}>
          <PersonAvatar person={pick.person} size={FACE} />
        </View>
      ))}
    </View>
  );
}

/** A revealed option: its letter and words, who called it, a tick on the right answer, and a plot twist on the person's own miss. */
function RevealedOption({ call, option }: { readonly call: Revealed; readonly option: number }) {
  const picks = call.picks.filter((pick) => pick.option === option);
  const isAnswer = option === call.answer;
  const twist = option === call.option && !call.right;
  const label = [
    `Option ${optionLetter(option)}. ${call.options[option] ?? ''}.`,
    isAnswer ? 'Right answer.' : undefined,
    twist ? 'Your call: a plot twist.' : undefined,
    calledBy(call.picks, option),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <View
      role="listitem"
      accessibilityLabel={label}
      style={[styles.option, isAnswer ? styles.optionRight : null]}
      testID={`call-revealed-${String(option)}`}
    >
      <View style={styles.letter} aria-hidden>
        <Text variant="monoXs" color={content.ink2}>
          {optionLetter(option)}
        </Text>
      </View>
      <Text variant="uiS" style={styles.optionText} aria-hidden>
        {call.options[option]}
      </Text>
      {twist ? (
        <View style={styles.twist} aria-hidden>
          <Text variant="monoXs" color={universe.paper}>
            PLOT TWIST
          </Text>
        </View>
      ) : null}
      <Callers picks={picks} />
      {isAnswer ? <Icon name="check" size={18} color={content.ink} /> : null}
    </View>
  );
}

function RevealedBody({ call }: { readonly call: Revealed }) {
  return (
    <>
      <View role="list" accessibilityLabel="Options and who called each" style={styles.options}>
        {call.options.map((_text, option) => (
          <RevealedOption key={option} call={call} option={option} />
        ))}
      </View>
      <Text variant="meta" testID="call-explain">
        {call.explain}
      </Text>
      {call.twist === undefined ? null : (
        <Text variant="meta" color={content.ink2} testID="call-twist">
          {call.twist}
        </Text>
      )}
      {call.guessSource === undefined ? null : (
        // The Scroll's own note, worded as the reader words it: authored and reviewed, never counted from anyone's pick.
        <Text variant="metaS" color={content.ink2} testID="call-common-guess">
          {`The common guess. Source: ${call.guessSource}.`}
        </Text>
      )}
    </>
  );
}

/**
 * One call, in whichever stage it is in. `open` is the one place a pick is made: choose an option (press, or its
 * number key), then Lock it in (or Enter). Once locked a pick cannot be changed, and the card says so. The `notice` is why
 * the last lock was not kept. Keys 1 to 3 choose, Enter locks (T3).
 */
export function CallCard({
  call,
  notice,
  locking,
  onLock,
  onClose,
}: {
  readonly call: ThreadCall;
  readonly notice: 'paused' | 'failed' | 'changed' | undefined;
  readonly locking: boolean;
  readonly onLock: (option: number) => void;
  readonly onClose: () => void;
}) {
  const [picked, setPicked] = useState<number>();
  const closeFocus = useFocusRing('onLight');
  const revealed = call.stage === 'revealed';
  const words = revealed ? revealWords(call) : undefined;
  const bandColour = !revealed ? universe.focus : call.right ? universe.fresh : universe.orange;
  const interactive = call.stage === 'open';
  const lock = () => {
    if (picked !== undefined && !locking) onLock(picked);
  };
  const onKeyDown = interactive
    ? (event: { nativeEvent?: { key?: string }; key?: string }) => {
        const key = event.nativeEvent?.key ?? event.key;
        const digit = key === undefined ? Number.NaN : Number.parseInt(key, 10);
        if (digit >= 1 && digit <= call.options.length) setPicked(digit - 1);
        else if (key === 'Enter') lock();
      }
    : undefined;
  return (
    <View
      role="region"
      aria-label={`Call it together, ${callPartLabel(call)}`}
      onKeyDown={onKeyDown}
      style={styles.card}
      testID="call-card"
    >
      <View style={[styles.band, { backgroundColor: bandColour }]}>
        <Text variant="monoXs" color={content.ink} style={styles.bandText}>
          {words === undefined
            ? `CALL IT TOGETHER · ${callPartLabel(call).toUpperCase()}`
            : `${words.title.toUpperCase()} · REVEALED TOGETHER`}
        </Text>
        {words?.spark === undefined ? null : (
          <Text variant="monoXs" color={content.ink} testID="call-spark">
            {`★ ${words.spark}`}
          </Text>
        )}
        <Pressable
          {...closeFocus.props}
          role="button"
          accessibilityLabel="Close call"
          onPress={onClose}
          style={[styles.close, closeFocus.style]}
          testID="call-close"
        >
          <Icon name="close" size={16} color={content.ink} />
        </Pressable>
      </View>
      <View style={styles.body}>
        <Text variant="ui" heading={3} testID="call-prompt">
          {call.prompt}
        </Text>
        {revealed ? (
          <RevealedBody call={call} />
        ) : (
          <View role={interactive ? 'radiogroup' : 'list'} accessibilityLabel={call.prompt} style={styles.options}>
            {call.options.map((text, option) =>
              interactive ? (
                <PickOption
                  key={option}
                  option={option}
                  text={text}
                  checked={picked === option}
                  disabled={locking}
                  onPick={() => setPicked(option)}
                  onEnter={lock}
                />
              ) : (
                <View
                  key={option}
                  role="listitem"
                  accessibilityLabel={`Option ${optionLetter(option)}. ${text}.${call.stage === 'locked' && call.option === option ? ' Your call.' : ''}`}
                  style={[
                    styles.option,
                    call.stage === 'locked' && call.option === option ? styles.optionPicked : null,
                  ]}
                  testID={`call-option-${String(option)}`}
                >
                  <View style={styles.letter} aria-hidden>
                    <Text variant="monoXs" color={content.ink2}>
                      {optionLetter(option)}
                    </Text>
                  </View>
                  <Text variant="uiS" style={styles.optionText} aria-hidden>
                    {text}
                  </Text>
                  {call.stage === 'locked' && call.option === option ? (
                    <>
                      <Text variant="monoXs" color={content.ink2} aria-hidden>
                        YOUR CALL
                      </Text>
                      <Icon name="check" size={18} color={content.ink} />
                    </>
                  ) : null}
                </View>
              ),
            )}
          </View>
        )}
        {call.updated === undefined ? null : (
          <Text variant="metaS" color={content.ink2} testID="call-updated">
            {callUpdateWords(call)}
          </Text>
        )}
        <View style={styles.summary}>
          {/* Before the reveal nobody is named: a "?" stands for each caller. After it the picks name them. */}
          <View style={styles.unknown} aria-hidden>
            {Array.from({ length: revealed ? 0 : Math.min(call.called, 3) }, (_unused, index) => (
              <View key={index} style={styles.unknownFace}>
                <Text variant="monoXs" color={universe.paper}>
                  ?
                </Text>
              </View>
            ))}
          </View>
          <Text variant="metaS" color={content.ink2} style={styles.summaryText} testID="call-summary">
            {callSummaryWords(call)}
          </Text>
        </View>
        {notice === undefined ? null : <LockNotice reason={notice} />}
        {interactive ? (
          <Button
            label="Lock it in"
            variant="ink"
            fullWidth
            busy={locking}
            busyLabel="Locking"
            disabled={picked === undefined}
            onPress={lock}
            testID="call-lock"
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * The bar above the composer that says a call is waiting (T3 "Call it first · 2 of 4 in"): the same yellow pill as the
 * chip on a part's row. Pressing it opens the card. It carries counts only.
 */
export function CallBar({ call, onOpen }: { readonly call: ThreadCall; readonly onOpen: () => void }) {
  const focus = useFocusRing('onLight');
  const words = callChipWords(call);
  if (words === undefined) return null;
  return (
    <View style={styles.barGround}>
      <Pressable
        {...focus.props}
        role="button"
        accessibilityLabel={`${words}. ${callPartLabel(call)}`}
        onPress={onOpen}
        style={[styles.chip, focus.style]}
        testID="call-bar"
      >
        <Text variant="uiS" color={content.ink}>
          {`★ ${words}`}
        </Text>
      </Pressable>
    </View>
  );
}

/** The chip on a part's row in the Series sheet and panel: only on a part that has a call and only while it has something to say. */
export function CallChip({ call, onOpen }: { readonly call: ThreadCall; readonly onOpen: () => void }) {
  const focus = useFocusRing('onLight');
  const words = callChipWords(call);
  if (words === undefined) return null;
  return (
    <Pressable
      {...focus.props}
      role="button"
      accessibilityLabel={`${words}. Open the call before Part ${String(call.part)}`}
      onPress={onOpen}
      style={[styles.chip, focus.style]}
      testID={`call-chip-${String(call.part)}`}
    >
      <Text variant="uiS" color={content.ink}>
        {`★ ${words}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[3],
    marginBottom: spacing[2],
    borderRadius: radius.panel,
    backgroundColor: universe.paper,
    overflow: 'hidden',
    boxShadow: universe.shadow.card,
  },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingLeft: spacing[4],
    paddingRight: spacing[2],
    minHeight: target.minimum,
  },
  bandText: { flex: 1 },
  close: { width: target.minimum, height: target.minimum, alignItems: 'center', justifyContent: 'center' },
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
  letter: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: universe.paper2,
  },
  twist: { paddingHorizontal: spacing[2], paddingVertical: 2, borderRadius: 10, backgroundColor: status.danger.fill },
  callers: { flexDirection: 'row' },
  you: { borderRadius: FACE / 2 + 2, borderWidth: 2, borderColor: universe.cobalt },
  summary: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  summaryText: { flex: 1 },
  unknown: { flexDirection: 'row' },
  unknownFace: {
    width: FACE,
    height: FACE,
    borderRadius: FACE / 2,
    marginRight: -6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: universe.ink,
    borderWidth: 2,
    borderColor: universe.paper,
  },
  barGround: { paddingHorizontal: spacing[3], paddingBottom: spacing[1] },
  chip: {
    alignSelf: 'flex-start',
    minHeight: target.minimum,
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: universe.focus,
    boxShadow: universe.shadow.chip,
  },
});
