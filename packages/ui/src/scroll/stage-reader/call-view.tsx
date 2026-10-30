import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { radioGroupSemantics, radioSemantics } from '../../display/semantics';
import { useFocusRing } from '../../display/focus-ring';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';
import { keepingNote, resultOf, type CallResult, type CallState } from './call-state';
import { PlayChip } from './play-chips';
import type { StageLock } from './stage-play';

interface OptionProps {
  readonly number: number;
  readonly text: string;
  readonly chosen: boolean;
  readonly locked: boolean;
  readonly right: boolean;
  readonly onPress: () => void;
}

function Option({ number, text, chosen, locked, right, onPress }: OptionProps) {
  const focus = useFocusRing('onLight');
  const dark = chosen && !(locked && right);
  return (
    <Pressable
      {...focus.props}
      {...radioSemantics(chosen)}
      accessibilityLabel={`${String(number)}. ${text}`}
      aria-disabled={locked}
      disabled={locked}
      onPress={onPress}
      style={[
        styles.option,
        chosen ? styles.optionChosen : null,
        locked && right ? styles.optionRight : null,
        focus.style,
      ]}
    >
      <View style={[styles.number, chosen ? styles.numberChosen : null]} aria-hidden>
        <Text variant="metaS">{String(number)}</Text>
      </View>
      <Text variant="ui" color={dark ? content.paper : content.ink} style={styles.optionText}>
        {text}
      </Text>
    </Pressable>
  );
}

/** What a revealed call shows: the pills, what the person called, why, and (on a Plot twist) the warm second look. */
function Reveal({
  call,
  result,
  picked,
  lock,
  onLayout,
}: {
  readonly call: CallItStop | FinalCallStop;
  readonly result: CallResult;
  readonly picked: number;
  /** Present for a Call it that play holds; the Final call is not played here yet. */
  readonly lock: StageLock | undefined;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  const note = lock === undefined ? undefined : keepingNote(lock.keeping);
  return (
    <View style={styles.reveal} accessibilityLiveRegion="polite" role="status" testID="call-reveal" onLayout={onLayout}>
      <View style={styles.chips}>
        {result.correct ? (
          <PlayChip label="Called it!" tone="called_it" />
        ) : (
          <PlayChip label="Plot twist!" tone="plot_twist" />
        )}
        {lock !== undefined && result.correct ? <PlayChip label="+1 spark" tone="earned" /> : null}
        {lock !== undefined && result.correct && lock.combo >= 2 ? (
          <PlayChip label={`Combo ×${String(lock.combo)}`} tone="earned" />
        ) : null}
      </View>
      {result.correct ? null : (
        <Text variant="meta" color={content.ink2}>
          {`You called: ${call.options[picked] ?? ''}`}
        </Text>
      )}
      <Text variant="body">{call.explain}</Text>
      {result.correct ? null : (
        <View style={styles.twist}>
          {result.guessSource === undefined ? null : (
            <Text variant="label" color={content.ink2}>
              You're in good company
            </Text>
          )}
          <Text variant="body">{call.twist}</Text>
          {result.guessSource === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {`The common guess. Source: ${result.guessSource}.`}
            </Text>
          )}
        </View>
      )}
      {note === undefined ? null : (
        <Text variant="meta" color={content.ink2} testID="play-note">
          {note}
        </Text>
      )}
    </View>
  );
}

/**
 * A call: choose, lock in, then see why (D-124). The reveal is the game's best moment: "Called it!"
 * with a spark for a right pick, "Plot twist!" for a wrong one, never a failure and never a penalty
 * (D-064). What was picked and whether it was right stay with the play layer; the only thing reported
 * is that the answer was shown, by kind (D-063). A Plot twist shows the reviewed source of the common
 * guess when that is what was picked. While recording is paused the screen says nothing is saved.
 */
export function CallView({
  call,
  position,
  state,
  lock,
  paused,
  onRevealLayout,
  onPick,
  onLockIn,
}: {
  readonly call: CallItStop | FinalCallStop;
  /** "1 of 3": the call's place among the Scroll's calls. */
  readonly position: string;
  readonly state: CallState;
  /** What play holds of this call (a Call it that was locked); absent before the lock and for the Final call. */
  readonly lock: StageLock | undefined;
  /** Recording is paused: whatever is locked stays on this device. */
  readonly paused: boolean;
  /** The reveal was laid out, this tall: the reader brings it on screen. */
  readonly onRevealLayout: (height: number) => void;
  readonly onPick: (option: number) => void;
  readonly onLockIn: () => void;
}) {
  const result = resultOf(call, state);
  return (
    <View style={styles.call}>
      <Tag label={call.kind === 'final_call' ? 'Final call' : `Call it · ${position}`} variant="part" />
      <Text variant="title" heading={2}>
        {call.prompt}
      </Text>
      <View {...radioGroupSemantics(call.prompt)} style={styles.options}>
        {call.options.map((text, index) =>
          // Once the answer is shown only what was called and what was right stay: the reveal needs the room.
          state.revealed && index !== state.picked && index !== call.answer ? null : (
            <Option
              key={text}
              number={index + 1}
              text={text}
              chosen={state.picked === index}
              locked={state.revealed}
              right={index === call.answer}
              onPress={() => onPick(index)}
            />
          ),
        )}
      </View>
      {state.revealed ? null : (
        <Button label="Lock it in" variant="primary" disabled={state.picked === undefined} onPress={onLockIn} />
      )}
      {state.revealed || !paused || call.kind === 'final_call' ? null : (
        <Text variant="meta" color={content.ink2} testID="play-note">
          Not saved while recording is paused.
        </Text>
      )}
      {result === undefined || state.picked === undefined ? null : (
        <Reveal
          call={call}
          result={result}
          picked={state.picked}
          lock={lock}
          onLayout={(event) => onRevealLayout(event.nativeEvent.layout.height)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  call: { gap: spacing[3], alignItems: 'flex-start' },
  options: { gap: spacing[2], alignSelf: 'stretch' },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 52,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  optionChosen: { backgroundColor: content.ink },
  optionRight: { backgroundColor: content.freshTint, borderColor: content.freshInk },
  number: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  numberChosen: { backgroundColor: content.continue },
  optionText: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  twist: {
    gap: spacing[1],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  reveal: {
    alignSelf: 'stretch',
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
});
