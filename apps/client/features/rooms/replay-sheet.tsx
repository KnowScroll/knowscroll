import { useEffect } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { LAUNCH_QUESTIONS } from '@knowscroll/contracts';
import {
  REPLAY_ANSWER_MS,
  replayBanner,
  replayCountLine,
  replayHostLine,
  replayScoreLine,
  type RoomReplayController,
  type RoomReplayState,
} from '@knowscroll/client-core';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { Faces, HostMark, LETTERS, Option, TimerRing, useDigitKeys } from './launch-stage';
import { useSteadyNow } from './use-launch';

/** The host of the Launch, labelled AI, and the template line it says for where the replay is: no model is behind any of it. */
function Host({ state, line }: { readonly state: RoomReplayState; readonly line: string }) {
  const host = state.host;
  if (host === undefined) return null;
  return (
    <View style={styles.host}>
      <View style={styles.hostHead}>
        <HostMark />
        <Text variant="ui" testID="replay-host-name">
          {host.name}
        </Text>
        <AiLabel label={host.label} testID="replay-host-label" />
      </View>
      <View accessibilityLiveRegion="polite" aria-live="polite">
        <Text variant="bodyS" color={content.ink2} testID="replay-host-line">
          {line}
        </Text>
      </View>
    </View>
  );
}

/** One question of the replay: its number, its time while it is open, the words and the options; the key and who got it right once answered. */
function Question({
  state,
  controller,
}: {
  readonly state: RoomReplayState;
  readonly controller: RoomReplayController;
}) {
  const { replay, index, answer, picked } = state;
  const question = replay!.questions[index]!;
  const asking = state.step === 'asking';
  const now = useSteadyNow(asking);
  const left = Math.max(0, REPLAY_ANSWER_MS - (now - state.shownAt));
  const choose = (choice: number) => void controller.pick(choice);
  useDigitKeys(asking && picked === undefined && !state.working, question.options.length, choose);
  // The time ran out on this device's steady clock: the key is shown with no choice. Nothing is judged by it.
  useEffect(() => {
    if (asking && left === 0 && picked === undefined && !state.working) void controller.timeUp();
  }, [asking, left, picked, state.working, controller]);
  return (
    <View
      style={styles.card}
      testID="replay-question"
      role="region"
      accessibilityLabel={`Replay question ${String(index + 1)}`}
    >
      <View style={styles.head}>
        <Text variant="monoXs" color={content.ink2} testID="replay-round">
          {`REPLAY ${String(index + 1)} OF ${String(LAUNCH_QUESTIONS)}`}
        </Text>
        {asking ? <TimerRing ms={left} total={REPLAY_ANSWER_MS} /> : null}
      </View>
      <Text variant="title" heading={2} testID="replay-prompt">
        {question.prompt}
      </Text>
      <View role="group" accessibilityLabel="Options" style={styles.options}>
        {question.options.map((text, option) => (
          <Option
            key={text + String(option)}
            letter={LETTERS[option]!}
            text={text}
            index={option}
            open={asking}
            picked={picked === option}
            correct={answer !== undefined && answer.correct === option}
            locked={picked !== undefined || state.working}
            onPick={() => choose(option)}
          />
        ))}
      </View>
      {answer === undefined ? (
        <Text variant="metaS" color={content.ink2}>
          Tap an option, or press its number.
        </Text>
      ) : (
        <View style={styles.reveal} testID="replay-reveal">
          <Text variant="bodyS" testID="replay-explain">
            {answer.explain}
          </Text>
          <Text variant="metaS" color={content.ink2} testID="replay-called">
            {replayCountLine(answer)}
          </Text>
          <Faces faces={answer.calledIt} label="Called it" testID="replay-called-faces" />
          <View style={styles.verdict} testID="replay-verdict">
            <Text variant="title" heading={3}>
              {picked === undefined ? 'Time’s up' : picked === answer.correct ? 'Called it!' : 'Plot twist'}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * The replay of a finished Launch (R3 F frame 2): the room's last Launch played again alone against the answers the people who played
 * it gave. Every screen of it says what it is, in the black banner of the design: the night, how many played and that nothing is saved.
 * The host is the Launch's and labelled AI, with template lines; there is no model call, no star and no podium, and nothing about the
 * person is stored. The questions arrive without their key, which comes with each answer; nobody is named as wrong.
 */
export function ReplaySheet({
  visible,
  state,
  controller,
  onClose,
}: {
  readonly visible: boolean;
  readonly state: RoomReplayState;
  readonly controller: RoomReplayController;
  readonly onClose: () => void;
}) {
  const { replay, step } = state;
  const close = () => {
    controller.leave();
    onClose();
  };
  const outcome = state.answer === undefined ? undefined : { picked: state.picked, correct: state.answer.correct };
  return (
    // `fit`: the black banner (D-241) and the buttons stay in view and the question scrolls between them, whatever the text size.
    <BottomSheet visible={visible} title="Replay" onClose={close} testID="replay-sheet" fit>
      <View style={styles.body}>
        {replay === undefined ? (
          <Text variant="bodyS" color={content.ink2} testID="replay-none">
            {state.phase === 'loading'
              ? 'Looking for a Launch to replay…'
              : state.phase === 'failed'
                ? 'Couldn’t reach the room. Try again in a moment.'
                : 'There is no Launch to replay right now.'}
          </Text>
        ) : (
          <>
            <View style={styles.banner} testID="replay-banner" role="note">
              <Text variant="bodyS" color={content.paper}>
                {replayBanner(replay)}
              </Text>
            </View>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrolled}
              testID="replay-scroll"
              // A region that scrolls is reachable by keyboard (axe: scrollable-region-focusable).
              tabIndex={0}
              role="region"
              aria-label="Replay"
              showsVerticalScrollIndicator={false}
            >
              <Host state={state} line={replayHostLine(state.host ?? { name: 'Pixel' }, step, state.index, outcome)} />
              {step === 'idle' ? null : step === 'done' ? (
                <View style={styles.reveal} testID="replay-done">
                  <Text variant="title" heading={2}>
                    {replayScoreLine(state.squares)}
                  </Text>
                  <Text variant="metaS" color={content.ink2}>
                    This replay is just for you. The podium and the room’s star stay as they were.
                  </Text>
                </View>
              ) : (
                <>
                  <Question state={state} controller={controller} />
                  {state.offline ? (
                    <Banner kind="offline" lead="Reconnecting…" message="Tap your answer again when you’re back." />
                  ) : null}
                </>
              )}
            </ScrollView>
            {step === 'idle' ? (
              <Button label="Start the replay" variant="primary" onPress={controller.begin} testID="replay-start" />
            ) : step === 'done' ? (
              <View style={styles.actions}>
                <Button label="Play it again" variant="default" onPress={controller.begin} testID="replay-again" />
                <Button label="Done" variant="primary" onPress={close} testID="replay-done-button" />
              </View>
            ) : (
              <View style={styles.actions}>
                <Button label="Leave replay" variant="ghost" onPress={close} testID="replay-leave" />
                {step === 'revealed' ? (
                  <Button
                    label={state.index + 1 >= LAUNCH_QUESTIONS ? 'See how you did' : 'Next question'}
                    variant="primary"
                    onPress={controller.next}
                    testID="replay-next"
                  />
                ) : null}
              </View>
            )}
          </>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3], flexShrink: 1, minHeight: 0 },
  scroll: { flexShrink: 1, flexGrow: 0 },
  scrolled: { gap: spacing[3], paddingBottom: spacing[2], paddingRight: spacing[2] },
  banner: { padding: spacing[3], borderRadius: radius.md, backgroundColor: content.ink },
  host: { gap: spacing[2] },
  hostHead: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.paper,
    boxShadow: elevation.raised,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2] },
  options: { gap: spacing[2] },
  reveal: { gap: spacing[2] },
  verdict: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.continue,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
});
