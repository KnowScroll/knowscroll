import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { CallItStop } from '@knowscroll/scroll-model';
import { PlayChip, Text, radioGroupSemantics, radioSemantics, useFocusRing, type StagePlay } from '@knowscroll/ui';
import { pickPuzzle } from './puzzle-pick';
import type { OpenedStageScroll } from '../scroll/scroll-session';

function Option({
  number,
  text,
  chosen,
  right,
  revealed,
  onPress,
}: {
  readonly number: number;
  readonly text: string;
  readonly chosen: boolean;
  readonly right: boolean;
  readonly revealed: boolean;
  readonly onPress: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      {...focus.props}
      {...radioSemantics(chosen)}
      accessibilityLabel={`${String(number)}. ${text}`}
      aria-disabled={revealed}
      disabled={revealed}
      onPress={onPress}
      style={[
        styles.option,
        revealed && right ? styles.right : null,
        chosen && !right ? styles.chosen : null,
        focus.style,
      ]}
    >
      <View style={styles.number} aria-hidden>
        <Text variant="metaS">{String(number)}</Text>
      </View>
      <Text variant="ui" style={styles.optionText}>
        {text}
      </Text>
    </Pressable>
  );
}

/**
 * "Meanwhile · 20-second puzzle": one of the Scroll's own calls, played in place with one tap on an option (D1). The
 * answer is judged by the play layer, as in the reader: a right pick is "Called it!" with its spark, a wrong one a
 * "Plot twist!", never a failure (D-064). Recording paused, it works on the device and says nothing is saved (D-083).
 */
export function AskPuzzle({
  scroll,
  anchorStopId,
  play,
}: {
  readonly scroll: OpenedStageScroll;
  readonly anchorStopId: string;
  readonly play: StagePlay;
}) {
  // Chosen once, when the wait begins: the card does not swap to another call under the person's finger.
  const [call] = useState<CallItStop | undefined>(() =>
    pickPuzzle(scroll.document, new Set(play.locks.map((lock) => lock.stopId)), anchorStopId),
  );
  if (call === undefined) return null;
  const lock = play.locks.find((candidate) => candidate.stopId === call.id);
  return (
    <View style={styles.card} testID="ask-puzzle">
      <Text variant="label" color={content.ink2}>
        MEANWHILE · 20-SECOND PUZZLE
      </Text>
      <Text variant="title" heading={3}>
        {call.prompt}
      </Text>
      <View {...radioGroupSemantics(call.prompt)} style={styles.options}>
        {call.options.map((text, index) => (
          <Option
            key={text}
            number={index + 1}
            text={text}
            chosen={lock?.option === index}
            right={index === call.answer}
            revealed={lock !== undefined}
            onPress={() => play.lock(call.id, index)}
          />
        ))}
      </View>
      {lock === undefined ? null : (
        <View style={styles.reveal} role="status" accessibilityLiveRegion="polite" testID="ask-puzzle-reveal">
          <View style={styles.chips}>
            {lock.correct ? (
              <PlayChip label="Called it!" tone="called_it" />
            ) : (
              <PlayChip label="Plot twist!" tone="plot_twist" />
            )}
            {lock.correct ? (
              <PlayChip label={lock.earned === 1 ? '+1 spark' : `+${String(lock.earned)} sparks`} tone="earned" />
            ) : null}
          </View>
          <Text variant="bodyS">{call.explain}</Text>
          {lock.correct ? null : <Text variant="bodyS">{call.twist}</Text>}
          {play.paused ? (
            <Text variant="meta" color={content.ink2}>
              Not saved while recording is paused.
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  options: { gap: spacing[2] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: 48,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  right: { backgroundColor: content.freshTint, borderColor: content.freshInk },
  chosen: { backgroundColor: content.paper2 },
  number: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  optionText: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  reveal: { gap: spacing[2] },
});
