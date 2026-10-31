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
import { TiltControl } from './tilt-control';

/** What the Final call says and offers beyond a Call it (D-187, D-188). */
export interface FinalCallPlay {
  /** The Scroll names a landmark: the Final call is announced as the way to its gold finish, and a miss is told it still earns it. */
  readonly hasLandmark: boolean;
  /** The combo the person holds going in; two or more means a right answer earns a second spark. */
  readonly bonusReady: boolean;
  readonly combo: number;
  /** The tilt the reader may turn on the picture, when the Scroll hands it over. */
  readonly tilt?: {
    readonly value: number;
    readonly onChange: (degrees: number) => void;
    readonly onDragging: (dragging: boolean) => void;
  };
}

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
  landmarkNote,
  onLayout,
}: {
  readonly call: CallItStop | FinalCallStop;
  readonly result: CallResult;
  readonly picked: number;
  /** Present for a call that play holds. */
  readonly lock: StageLock | undefined;
  /** A Final call that missed is told, in the reveal, that the landmark is still earned. */
  readonly landmarkNote: boolean;
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
        {lock !== undefined && result.correct ? (
          <PlayChip label={lock.earned === 1 ? '+1 spark' : `+${String(lock.earned)} sparks`} tone="earned" />
        ) : null}
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
      {landmarkNote && !result.correct ? (
        <Text variant="meta" color={content.ink2} testID="landmark-still-earned">
          You still earn the landmark, in the plain finish.
        </Text>
      ) : null}
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
 *
 * The Final call is the same view with its own words before the lock: the way to the gold landmark,
 * whether the combo doubles it, and, when the Scroll hands it over, the tilt of Earth's axis to turn
 * on the picture (D-187). A miss still earns the landmark, in the plain finish (D-188).
 */
export function CallView({
  call,
  position,
  state,
  lock,
  paused,
  final,
  onRevealLayout,
  onPick,
  onLockIn,
}: {
  readonly call: CallItStop | FinalCallStop;
  /** "1 of 3": the call's place among the Scroll's calls. */
  readonly position: string;
  readonly state: CallState;
  /** What play holds of this call; absent before the lock. */
  readonly lock: StageLock | undefined;
  /** Recording is paused: whatever is locked stays on this device. */
  readonly paused: boolean;
  /** Present for the Final call. */
  readonly final?: FinalCallPlay | undefined;
  /** The reveal was laid out, this tall: the reader brings it on screen. */
  readonly onRevealLayout: (height: number) => void;
  readonly onPick: (option: number) => void;
  readonly onLockIn: () => void;
}) {
  const result = resultOf(call, state);
  return (
    <View style={styles.call}>
      <Tag label={call.kind === 'final_call' ? 'Final call' : `Call it · ${position}`} variant="part" />
      {final === undefined || state.revealed ? null : <FinalCallAnnouncement final={final} />}
      <Text variant="title" heading={2}>
        {call.prompt}
      </Text>
      {final?.tilt === undefined ? null : (
        <TiltControl value={final.tilt.value} onChange={final.tilt.onChange} onDragging={final.tilt.onDragging} />
      )}
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
      {state.revealed || !paused ? null : (
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
          landmarkNote={final?.hasLandmark === true}
          onLayout={(event) => onRevealLayout(event.nativeEvent.layout.height)}
        />
      )}
    </View>
  );
}

/** Before the lock: what this call is for, said plainly, so the reward is earned and never gambled. */
function FinalCallAnnouncement({ final }: { readonly final: FinalCallPlay }) {
  return (
    <View style={styles.chips}>
      {final.hasLandmark ? (
        <Text variant="label" color={content.ink2} testID="final-call-gold-note">
          Get it first try for the gold landmark
        </Text>
      ) : null}
      {final.bonusReady ? (
        <PlayChip label={`Combo ×${String(final.combo)} doubles this one`} tone="earned" testID="final-call-combo" />
      ) : null}
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
