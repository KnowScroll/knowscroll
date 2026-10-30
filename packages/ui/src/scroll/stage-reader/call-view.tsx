import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { radioGroupSemantics, radioSemantics } from '../../display/semantics';
import { useFocusRing } from '../../display/focus-ring';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';
import { resultOf, type CallState } from './call-state';

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

/**
 * A call: choose, lock in, then see why (D-124). Playing it changes nothing but this screen: the
 * answer is shown on the device, and the only thing reported is that it was shown (the reveal), never
 * which option was picked (D-063). The Plot twist is warm, never blaming, and shows the reviewed
 * source of the common guess when that is what was picked.
 */
export function CallView({
  call,
  position,
  state,
  onPick,
  onLockIn,
}: {
  readonly call: CallItStop | FinalCallStop;
  /** "1 of 3": the call's place among the Scroll's calls. */
  readonly position: string;
  readonly state: CallState;
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
        {call.options.map((text, index) => (
          <Option
            key={text}
            number={index + 1}
            text={text}
            chosen={state.picked === index}
            locked={state.revealed}
            right={index === call.answer}
            onPress={() => onPick(index)}
          />
        ))}
      </View>
      {state.revealed ? null : (
        <Button label="Lock it in" variant="primary" disabled={state.picked === undefined} onPress={onLockIn} />
      )}
      {result === undefined ? null : (
        <View style={styles.reveal} accessibilityLiveRegion="polite" role="status">
          {result.correct ? null : <Tag label="Plot twist!" variant="neutral" />}
          <Text variant="body">{call.explain}</Text>
          {result.correct ? null : <Text variant="body">{call.twist}</Text>}
          {result.guessSource === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {`The common guess. Source: ${result.guessSource}.`}
            </Text>
          )}
        </View>
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
