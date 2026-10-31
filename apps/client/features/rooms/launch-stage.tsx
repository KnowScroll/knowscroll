import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { LAUNCH_ANSWER_SECONDS, type LaunchFace, type LaunchHost, type LaunchView } from '@knowscroll/contracts';
import {
  hostLine,
  initialsOf,
  secondsLeft,
  timeLeftMs,
  type RoomLaunchController,
  type RoomLaunchState,
} from '@knowscroll/client-core';
import { borderWidth, content, elevation, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { useSteadyNow } from './use-launch';

type Running = Exclude<LaunchView, { phase: 'finished' }>;

const LETTERS = ['A', 'B', 'C'] as const;

/** Face colours: fixed, never a score, picked from the person's own ID so a face keeps its colour. */
const FACE_COLOURS = [content.continue, content.fresh, content.paper, content.paper2] as const;
const colourOf = (personId: string): string => {
  let hash = 0;
  for (const character of personId) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return FACE_COLOURS[hash % FACE_COLOURS.length]!;
};

/** The people who are in or who got a question right, as small faces with their names for a screen reader. */
function Faces({
  faces,
  label,
  testID,
}: {
  readonly faces: readonly LaunchFace[];
  readonly label: string;
  readonly testID: string;
}) {
  if (faces.length === 0) return null;
  const names = faces
    .map((face) => (face.you ? `${face.person.displayName}, you` : face.person.displayName))
    .join(', ');
  return (
    <View
      style={styles.faces}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${label}: ${names}`}
      testID={testID}
    >
      {faces.map((face) => (
        <View
          key={face.person.personId}
          aria-hidden
          style={[styles.face, { backgroundColor: colourOf(face.person.personId) }, face.you ? styles.faceYou : null]}
        >
          <Text variant="label" color={content.ink}>
            {initialsOf(face.person.displayName)}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The host's mark: a small rocket on a square tile. Squares are how an AI is drawn in a room (never a face); the words beside it,
 * "AI · Quizmaster", are what carry the meaning.
 */
function HostMark() {
  return (
    <View style={styles.hostMark} aria-hidden importantForAccessibility="no-hide-descendants">
      <Svg width={26} height={26} viewBox="0 0 24 24">
        <Path d="M12 2c3 3 4.2 7 4 10.5l2.2 3.8-3.4-1h-5.6l-3.4 1L8 12.5C7.8 9 9 5 12 2z" fill={content.paper} />
        <Circle cx={12} cy={9} r={1.7} fill={content.ink} />
        <Rect x={10.5} y={17.5} width={3} height={4} rx={1} fill={content.continue} />
      </Svg>
    </View>
  );
}

/** The time left as a ring and as words ("8 s"): the ring steps and never needs motion, and the words are the real reading. */
function TimerRing({ ms, total }: { readonly ms: number; readonly total: number }) {
  const size = 46;
  const stroke = 4;
  const radiusOf = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radiusOf;
  const share = Math.max(0, Math.min(1, ms / total));
  return (
    <View
      style={styles.timer}
      testID="launch-timer"
      accessibilityRole="timer"
      accessibilityLabel={`${String(secondsLeft(ms))} seconds left`}
    >
      <Svg width={size} height={size} aria-hidden>
        <Circle cx={size / 2} cy={size / 2} r={radiusOf} stroke={content.rule} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radiusOf}
          stroke={content.ink}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${String(circumference)} ${String(circumference)}`}
          strokeDashoffset={circumference * (1 - share)}
          transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
        />
      </Svg>
      <View style={styles.timerText} aria-hidden>
        <Text variant="label">{`${String(secondsLeft(ms))} s`}</Text>
      </View>
    </View>
  );
}

/** One option: a button with its letter and words while the question is open, then marked in words as the right one or yours. */
function Option({
  letter,
  text,
  index,
  open,
  picked,
  correct,
  locked,
  onPick,
}: {
  readonly letter: string;
  readonly text: string;
  readonly index: number;
  readonly open: boolean;
  readonly picked: boolean;
  /** Only once the question has closed: this is the right option. */
  readonly correct: boolean;
  /** An answer is in: the options no longer take taps. */
  readonly locked: boolean;
  readonly onPick: () => void;
}) {
  const tag = correct ? 'Right answer' : picked ? (open ? 'Locked in' : 'Your pick') : undefined;
  return (
    <Pressable
      role="button"
      accessibilityLabel={`Option ${letter}: ${text}${tag === undefined ? '' : `, ${tag}`}`}
      aria-pressed={picked}
      accessibilityState={{ disabled: !open || locked, selected: picked }}
      aria-disabled={!open || locked}
      disabled={!open || locked}
      onPress={onPick}
      style={[styles.option, picked ? styles.optionPicked : null, correct ? styles.optionRight : null]}
      testID={`launch-option-${String(index)}`}
    >
      <View style={styles.letter} aria-hidden>
        <Text variant="label">{letter}</Text>
      </View>
      <View style={styles.optionText}>
        <Text variant="ui">{text}</Text>
        {tag === undefined ? null : (
          <Text variant="monoXs" color={content.ink2}>
            {tag}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** On the web a digit key picks the option with that number, unless the person is typing somewhere (R3: "options keys 1-4"). */
function useDigitKeys(enabled: boolean, count: number, onDigit: (index: number) => void): void {
  useEffect(() => {
    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const index = Number(event.key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < count) onDigit(index);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [enabled, count, onDigit]);
}

/** Words for a command that did not go through, for the one question this device cannot answer by itself. */
function Notices({ state }: { readonly state: RoomLaunchState }) {
  return (
    <>
      {state.recordingPaused || state.notSaved === 'recording_paused' ? (
        <Banner
          kind="recordingPaused"
          lead="Recording is paused."
          message="A Launch keeps your answers, so it can’t be played while recording is paused. Turn recording back on in Privacy to join the next one."
          testID="launch-paused"
        />
      ) : state.notSaved === 'recording_generation_stale' ? (
        <Banner
          kind="error"
          lead="Couldn’t keep your answer."
          message="Your recording setting changed on another device."
          testID="launch-stale"
        />
      ) : null}
      {state.refused ? (
        <Banner
          kind="error"
          lead="Too late for that one."
          message="The Launch has moved on. Here is where it is now."
        />
      ) : null}
      {state.offline ? (
        <Banner kind="offline" lead="Reconnecting…" message="Your next answer will go as soon as you’re back." />
      ) : null}
    </>
  );
}

/**
 * The Launch on the room's stage (R3 E, A2): the host, the question, its time left, the options and, once it closes, the right
 * answer, the reason and who got it right. General keeps going below as the crowd. Everything here is the server's: the question
 * only while it is open, the answer only after it closes; the clock is the server's own, counted here by a steady clock from the time
 * left each read carried. The host speaks template lines and is labelled AI; no model is behind any of it.
 */
export function LaunchStage({
  launch,
  host,
  state,
  controller,
}: {
  readonly launch: Running;
  readonly host: LaunchHost;
  readonly state: RoomLaunchState;
  readonly controller: RoomLaunchController;
}) {
  const now = useSteadyNow(true);
  const left = timeLeftMs(launch, now - state.receivedAt) ?? 0;
  const asking = launch.phase === 'open';
  const answered = launch.phase === 'open' && launch.yourChoice !== undefined;
  const pick = (index: number) => void controller.answer(index);
  useDigitKeys(asking && !answered, launch.phase === 'open' ? launch.options.length : 0, pick);
  return (
    <View style={styles.outer}>
      <View style={styles.card} testID="launch-stage" accessibilityLabel="The Launch" role="region">
        <View style={styles.head}>
          <HostMark />
          <View style={styles.who}>
            <Text variant="ui" testID="launch-host-name">
              {host.name}
            </Text>
            <AiLabel label={host.label} testID="launch-host-label" />
          </View>
          {launch.phase === 'lobby' ? null : (
            <Text variant="monoXs" color={content.ink2} testID="launch-round">
              {`${String(launch.round)} OF ${String(launch.of)}`}
            </Text>
          )}
          {launch.phase === 'reveal' ? null : (
            <TimerRing
              ms={left}
              total={launch.phase === 'open' ? LAUNCH_ANSWER_SECONDS * 1000 : Math.max(left, 20_000)}
            />
          )}
        </View>
        {/* The host's line is the one thing a screen reader is told as the game moves: a phase at a time, never a tick. */}
        <View accessibilityLiveRegion="polite" aria-live="polite">
          <Text variant="bodyS" color={content.ink2} testID="launch-host-line">
            {hostLine(launch, host)}
          </Text>
        </View>
        {launch.phase === 'lobby' ? (
          <View style={styles.lobby}>
            <Text variant="title" heading={2}>
              {`Starting in ${String(secondsLeft(left))} s`}
            </Text>
            <Faces faces={launch.players} label="In this Launch" testID="launch-players" />
            {launch.youIn ? (
              <Text variant="ui" testID="launch-in">
                You’re in.
              </Text>
            ) : (
              <Button
                label="Join the Launch"
                variant="primary"
                onPress={() => void controller.join()}
                disabled={state.working || state.recordingPaused}
                testID="launch-join"
              />
            )}
          </View>
        ) : (
          <>
            <Text variant="title" heading={2} testID="launch-prompt">
              {launch.prompt}
            </Text>
            <View role="group" accessibilityLabel="Options" style={styles.options}>
              {launch.options.map((text, index) => (
                <Option
                  key={text + String(index)}
                  letter={LETTERS[index]!}
                  text={text}
                  index={index}
                  open={asking}
                  picked={launch.yourChoice === index}
                  correct={launch.phase === 'reveal' && launch.correct === index}
                  locked={answered || state.working || state.recordingPaused}
                  onPick={() => pick(index)}
                />
              ))}
            </View>
            {launch.phase === 'open' ? (
              answered ? (
                <Text variant="metaS" color={content.ink2} testID="launch-locked">
                  Locked in. The answer comes when the time is up.
                </Text>
              ) : launch.youIn ? (
                <Text variant="metaS" color={content.ink2}>
                  Tap an option, or press its number.
                </Text>
              ) : (
                <Text variant="metaS" color={content.ink2} testID="launch-watching">
                  You’re watching. Answer to join in.
                </Text>
              )
            ) : (
              <View style={styles.reveal} testID="launch-reveal">
                <Text variant="bodyS" testID="launch-explain">
                  {launch.explain}
                </Text>
                <Text variant="metaS" color={content.ink2} testID="launch-called">
                  {launch.locked === 0
                    ? 'Nobody answered this one.'
                    : `${String(launch.right)} of ${String(launch.locked)} called it`}
                </Text>
                <Faces faces={launch.calledIt} label="Called it" testID="launch-called-faces" />
              </View>
            )}
          </>
        )}
        <Notices state={state} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The stage keeps the reading measure, centred, on wide screens.
  outer: { alignItems: 'center', paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  card: {
    width: '100%',
    maxWidth: layout.measureDesktop,
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.paper,
    // The design's stage card carries the chunky ink shadow (R3 E).
    boxShadow: elevation.raised,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' },
  who: { flex: 1, minWidth: 140, gap: spacing['0.5'] },
  hostMark: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.thumb,
    backgroundColor: content.ink,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  timer: { width: 46, height: 46, alignItems: 'center', justifyContent: 'center' },
  timerText: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  lobby: { gap: spacing[3] },
  options: { gap: spacing[2] },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  optionPicked: { backgroundColor: content.continue },
  optionRight: { backgroundColor: content.fresh, borderWidth: borderWidth.regular },
  letter: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.thumb,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  optionText: { flex: 1, gap: spacing['0.5'] },
  reveal: { gap: spacing[2] },
  faces: { flexDirection: 'row', alignItems: 'center', gap: spacing[1], flexWrap: 'wrap' },
  face: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  faceYou: { borderColor: content.accent },
});
