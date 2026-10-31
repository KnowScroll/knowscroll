import { useRouter } from 'expo-router';
import { useEffect, useRef, type ComponentRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View, findNodeHandle } from 'react-native';
import type { RoomTodayController, RoomTodayState } from '@knowscroll/client-core';
import type { ConversationContentProjection, RoomToday } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';
import { dayHeading, messagesWords } from './today-words';

type Ready = Extract<RoomToday, { status: 'ready' }>;
type Question = NonNullable<Ready['question']>;
type Flaw = NonNullable<Ready['flaw']>;

/** The Scroll an item came from, when it can still be read: its title and ID. */
function sourceOf(
  card: ConversationContentProjection,
): { readonly title: string; readonly assetId: string } | undefined {
  const metadata =
    card.status === 'available' ? card.metadata : card.status === 'corrected' ? card.current.metadata : undefined;
  return metadata === undefined ? undefined : { title: metadata.title, assetId: card.target.assetId };
}

/** "From <Scroll>": the passage's source as a link that opens the Scroll. Nothing else about it is shown. */
function SourceLink({ card }: { readonly card: ConversationContentProjection }) {
  const router = useRouter();
  const source = sourceOf(card);
  if (source === undefined) return null;
  return (
    <Pressable
      role="link"
      accessibilityLabel={`Read the Scroll: ${source.title}`}
      onPress={() => router.push(`/scroll/${source.assetId}`)}
      style={styles.link}
      testID="today-source"
    >
      <Text variant="meta" color={content.accentDeep}>{`From the Scroll: ${source.title}`}</Text>
    </Pressable>
  );
}

/** Who asks: the resident's name and its label, which cannot be taken off. Never drawn as a person. */
function Resident({ by }: { readonly by: Question['by'] }) {
  return (
    <View style={styles.resident}>
      <Text variant="ui">{by.name}</Text>
      <AiLabel label={by.label} />
    </View>
  );
}

/** R3 B "Today's question": a template over a library Scroll that an operator approved, and where to answer it. */
function QuestionCard({ question, onAnswer }: { readonly question: Question; readonly onAnswer: () => void }) {
  return (
    <View style={[styles.card, styles.question]} testID="today-question">
      <Text variant="monoXs" color={content.ink2}>
        TODAY’S QUESTION
      </Text>
      <Resident by={question.by} />
      <Text variant="title" heading={2}>
        {question.prompt}
      </Text>
      {question.detail === undefined ? null : <Text variant="bodyS">{question.detail}</Text>}
      <SourceLink card={question.source} />
      <View style={styles.actions}>
        {question.messagesToday === 0 ? null : (
          <Text variant="metaS" color={content.ink2} testID="today-messages">
            {messagesWords(question.messagesToday)}
          </Text>
        )}
        <Button label="Answer" variant="primary" size="sm" onPress={onAnswer} testID="today-answer" />
      </View>
    </View>
  );
}

/** One sentence of the passage: a button until the tap, then marked by words so colour is never the only cue. */
function Sentence({
  text,
  index,
  flaw,
  busy,
  onTap,
}: {
  readonly text: string;
  readonly index: number;
  readonly flaw: Flaw;
  readonly busy: boolean;
  readonly onTap: () => void;
}) {
  const done = flaw.state === 'done';
  const altered = done && flaw.flawIndex === index;
  const picked = done && flaw.yourPick === index;
  return (
    <Pressable
      role="button"
      accessibilityLabel={`Sentence ${String(index + 1)}: ${text}${altered ? ', altered' : ''}${picked ? ', your tap' : ''}`}
      accessibilityState={{ disabled: done || busy }}
      aria-disabled={done || busy}
      disabled={done || busy}
      onPress={onTap}
      style={[styles.sentence, altered ? styles.altered : null, picked && !altered ? styles.pickedWrong : null]}
      testID={`flaw-sentence-${String(index)}`}
    >
      {altered ? (
        <Text variant="monoXs" color={content.ink2}>
          ALTERED
        </Text>
      ) : picked ? (
        <Text variant="monoXs" color={content.ink2}>
          YOUR TAP
        </Text>
      ) : null}
      <Text variant="bodyS">{text}</Text>
    </Pressable>
  );
}

/**
 * R3 E "Spot the flaw": a passage of a library Scroll with one sentence altered. One tap is the answer and it is final; the
 * key and the Scroll's own sentence come from the server only after it. The room earns a star for the first right tap of the day.
 */
function FlawCard({
  flaw,
  state,
  onTap,
}: {
  readonly flaw: Flaw;
  readonly state: RoomTodayState;
  readonly onTap: (index: number) => void;
}) {
  const done = flaw.state === 'done';
  const result = useRef<ComponentRef<typeof View>>(null);
  const wasOpen = useRef(!done);
  // The tapped sentence is no longer a button, so a keyboard or screen-reader user would be left on nothing: the result takes
  // focus when this tap finishes the item. An item that opens already finished keeps the reader where they are.
  useEffect(() => {
    if (!done || !wasOpen.current) return;
    wasOpen.current = false;
    const node = result.current;
    if (node === null) return;
    if (Platform.OS === 'web') (node as unknown as { focus?: () => void }).focus?.();
    else {
      const tag = findNodeHandle(node);
      if (typeof tag === 'number') AccessibilityInfo.setAccessibilityFocus(tag);
    }
  }, [done]);
  return (
    <View style={styles.card} testID="today-flaw">
      <Text variant="monoXs" color={content.ink2}>
        SPOT THE FLAW
      </Text>
      <Resident by={flaw.by} />
      {/* Mounted from the start, so a change of its words is announced: the result is said once, in words. */}
      <View accessibilityLiveRegion="polite" aria-live="polite" testID="flaw-status">
        <Text variant="ui">{flawStatus(flaw)}</Text>
      </View>
      <View style={styles.sentences}>
        {flaw.sentences.map((text, index) => (
          <Sentence
            key={text + String(index)}
            text={text}
            index={index}
            flaw={flaw}
            busy={state.working}
            onTap={() => onTap(index)}
          />
        ))}
      </View>
      {done ? (
        <View style={styles.reveal} testID="flaw-reveal">
          <View ref={result} accessible focusable tabIndex={-1} testID="flaw-result">
            <Text variant="bodyS">{`The Scroll says: ${flaw.original}`}</Text>
          </View>
          <SourceLink card={flaw.source} />
          <Text variant="metaS" color={content.ink2}>{`${String(flaw.found)} found it`}</Text>
          {state.starFor === flaw.ritualId ? (
            <Text variant="ui" color={content.accentDeep} testID="flaw-star">
              +1 star for the room
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="metaS" color={content.ink2}>
          Your tap is final.
        </Text>
      )}
      {state.refused ? (
        <Banner
          kind="error"
          lead="Couldn’t send your tap."
          message="Today’s item has changed. Here is how it stands now."
        />
      ) : null}
      {state.offline ? (
        <Banner
          kind="offline"
          lead="Not sent yet."
          message="Your tap hasn’t reached the room. Tap again when you’re back online."
        />
      ) : null}
      {state.notSaved === 'recording_paused' ? (
        <Banner
          kind="recordingPaused"
          lead="Recording is paused."
          message="Spot the flaw keeps your tap, so it can’t be played while recording is paused. Turn recording back on in Privacy, then tap again."
          testID="flaw-paused"
        />
      ) : state.notSaved === 'recording_generation_stale' ? (
        <Banner
          kind="error"
          lead="Couldn’t keep your tap."
          message="Your recording setting changed on another device. Tap again."
          testID="flaw-stale"
        />
      ) : null}
    </View>
  );
}

/** The one line the live region speaks: the prompt before the tap, and the result after it, with which sentence was altered. */
function flawStatus(flaw: Flaw): string {
  if (flaw.state === 'open') return 'One sentence below is wrong. Tap it.';
  const altered = `Sentence ${String(flaw.flawIndex + 1)} was altered`;
  return flaw.correct
    ? `Found it. ${altered}.`
    : `Not that one. ${altered}; you tapped sentence ${String(flaw.yourPick + 1)}.`;
}

/**
 * Today above the day's conversation (R3 B "Today channel"): the question, Spot the flaw and the days before. Everything
 * here was approved by an operator and cites a library Scroll; when nothing is approved for today it says so.
 */
export function TodayCards({
  view,
  state,
  controller,
  onAnswer,
}: {
  readonly view: Ready;
  readonly state: RoomTodayState;
  readonly controller: RoomTodayController;
  readonly onAnswer: () => void;
}) {
  const { question, flaw } = view;
  return (
    <View style={styles.cards} testID="today-cards">
      {question === undefined && flaw === undefined ? (
        <View style={styles.card}>
          <Text variant="ui">Nothing for today yet</Text>
          <Text variant="meta" color={content.ink2}>
            Today’s question and Spot the flaw appear here once they are ready. You can still talk below.
          </Text>
        </View>
      ) : null}
      {question === undefined ? null : <QuestionCard question={question} onAnswer={onAnswer} />}
      {flaw === undefined ? null : (
        <FlawCard flaw={flaw} state={state} onTap={(index) => void controller.solve(flaw.ritualId, index)} />
      )}
      {view.past.length === 0 ? null : (
        <View style={styles.past} role="list" accessibilityLabel="Past days">
          <Text variant="monoXs" color={content.ink2}>
            PAST DAYS
          </Text>
          {view.past.map((entry) => (
            <View key={entry.day} role="listitem" style={styles.pastRow}>
              <Text variant="metaS" color={content.ink2}>
                {dayHeading(entry.day)}
              </Text>
              <Text variant="bodyS" style={styles.pastPrompt}>
                {entry.prompt}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cards: { gap: spacing[3] },
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.paper,
  },
  question: { backgroundColor: content.continue },
  resident: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  link: { minHeight: 44, justifyContent: 'center' },
  sentences: { gap: spacing[2] },
  sentence: {
    minHeight: 44,
    gap: spacing['0.5'],
    padding: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  altered: { borderWidth: borderWidth.regular, borderColor: content.ink, backgroundColor: content.continue },
  pickedWrong: { borderStyle: 'dashed', borderWidth: borderWidth.regular, borderColor: content.ink },
  reveal: { gap: spacing[1] },
  past: { gap: spacing[1] },
  pastRow: { flexDirection: 'row', gap: spacing[3], alignItems: 'baseline' },
  pastPrompt: { flex: 1 },
});
