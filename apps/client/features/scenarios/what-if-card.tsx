import { StyleSheet, View } from 'react-native';
import {
  ANSWER_WAIT_WORDS,
  WHAT_IF_MADE_BY,
  answerLabel,
  answerStage,
  clockTime,
  madeInSeconds,
  statementsInWords,
  type AnswerStage,
} from '@knowscroll/client-core';
import type { ScenarioCard } from '@knowscroll/contracts';
import { borderWidth, radius, spacing, universe } from '@knowscroll/design-tokens';
import { Button, Icon, PendingStripe, Tag, Text, useTalkTheme } from '@knowscroll/ui';
import { BranchMenu, SPECULATIVE_NOTICE } from './branch-parts';

type ReadyAnswer = Extract<NonNullable<ScenarioCard['answer']>, { status: 'ready' }>;

/** How long the card took, as T3 says it ("MADE IN 26 S"): nothing under a second, minutes once it passes two. */
function madeInWords(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 1) return '';
  return seconds < 120 ? ` · MADE IN ${String(seconds)} S` : ` · MADE IN ${String(Math.round(seconds / 60))} MIN`;
}

/**
 * The labels every short answer carries: who made it (T3, D-211), as a pill, and the status of what it says. A what-if
 * is Hypothetical, or Speculative when its premise runs against established knowledge (D-006 a, D-056): the one status
 * label a branch has, kept on the card with its answer as on every branch card.
 */
function Labels({ card }: { readonly card: ScenarioCard }) {
  return (
    <View style={styles.labels}>
      <View style={styles.label} testID="what-if-label">
        <Icon name="hypothetical" size={14} color={universe.ink} />
        <Text variant="monoXs" color={universe.ink}>
          {WHAT_IF_MADE_BY}
        </Text>
      </View>
      {card.hypothetical ? (
        <Tag variant="hypothetical" label={card.speculative ? 'Speculative' : 'Hypothetical'} />
      ) : null}
    </View>
  );
}

/** One line of the card: a small caps name, then the words (ASSUMED, CHANGED, KEPT). */
function Line({
  name,
  words,
  tone,
}: {
  readonly name: string;
  readonly words: string;
  readonly tone: 'assumed' | 'changed' | 'kept';
}) {
  return (
    <View style={[styles.line, styles[tone]]} testID={`what-if-${tone}`}>
      <Text variant="monoXs" color={universe.ink2}>
        {name}
      </Text>
      <Text variant="bodyS" color={universe.ink}>
        {words}
      </Text>
    </View>
  );
}

/** The wait: honest about how long it usually takes, and about what has not happened yet (nothing is checked until it is). */
function Making({ stage }: { readonly stage: AnswerStage }) {
  const slow = stage === 'slow';
  return (
    <View
      style={styles.making}
      role="status"
      accessibilityLabel={slow ? 'Taking longer than usual' : 'Making a short what-if'}
    >
      <Text variant="ui" color={universe.ink}>
        {slow
          ? 'Taking longer than usual · keep chatting'
          : `Making a short what-if · ${ANSWER_WAIT_WORDS} · keep chatting`}
      </Text>
      <View style={styles.stripe}>
        <PendingStripe compact />
      </View>
      <Text variant="meta" color={universe.ink2}>
        We check it before it posts.
      </Text>
    </View>
  );
}

/** The answer: the assumption line first, what changed and what stayed, the answer, and any figure a source states. */
function Answer({ card, answer }: { readonly card: ScenarioCard; readonly answer: ReadyAnswer }) {
  return (
    <View style={styles.body}>
      <Line name="ASSUMED" words={answer.assumption} tone="assumed" />
      <Line name="CHANGED" words={statementsInWords(card.changes)} tone="changed" />
      {card.kept.length === 0 ? null : <Line name="KEPT" words={statementsInWords(card.kept)} tone="kept" />}
      <Text variant="bodyS" color={universe.ink} testID="what-if-answer">
        {answer.answer}
      </Text>
      {answer.numbers.length === 0 ? null : (
        <View style={styles.numbers} role="list" accessibilityLabel="Figures">
          {answer.numbers.map((figure) => (
            <View key={`${figure.label}:${figure.value}`} role="listitem" style={styles.figure}>
              <Text variant="monoXs" color={universe.ink2}>
                {figure.label.toUpperCase()}
              </Text>
              <Text variant="uiS" color={universe.ink}>
                {figure.value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** Where the full Scroll stands: Open once it exists, plainly what is true until then. */
function FullScroll({ card, onOpen }: { readonly card: ScenarioCard; readonly onOpen: (card: ScenarioCard) => void }) {
  if (card.status === 'ready')
    return <Button label="Open" variant="primary" size="sm" onPress={() => onOpen(card)} testID="what-if-open" />;
  if (card.status === 'preparing')
    return (
      <Text variant="meta" color={universe.ink2} testID="what-if-scroll-note">
        The full Scroll is still being made. Open appears when it is ready.
      </Text>
    );
  return (
    <Text variant="meta" color={universe.ink2} testID="what-if-scroll-note">
      The full Scroll couldn’t be made. This card still stands.
    </Text>
  );
}

/**
 * A what-if that has, is getting, or will not get a short answer (T3 "What-if · made by KnowScroll"). The wait is
 * honest: "about 30 s", the chat goes on, and nothing is shown that has not passed the card's checks. The card
 * always says KnowScroll made it. It carries nothing of where anyone is: "Opened by you" is the caller's own history.
 * Open goes to the full Scroll once it exists; Branch again asks What if from this branch; the member who asked can
 * cancel the wait or remove the branch.
 */
export function WhatIfCard({
  card,
  now,
  starterIsYou,
  startedLine,
  openedByYou,
  onOpen,
  onRemove,
  onContinue,
}: {
  readonly card: ScenarioCard;
  readonly now: Date;
  readonly starterIsYou: boolean;
  /** "from the thread", "from Ravi’s message", "from a moment": where it began, in words. */
  readonly startedLine: string;
  readonly openedByYou: boolean;
  readonly onOpen: (card: ScenarioCard) => void;
  readonly onRemove: (card: ScenarioCard) => void;
  readonly onContinue: (card: ScenarioCard) => void;
}) {
  const theme = useTalkTheme();
  const stage = answerStage(card, now);
  const { answer } = card;
  if (answer === undefined || stage === 'none' || stage === 'unavailable') return null;
  const asker = starterIsYou
    ? 'ASKED BY YOU'
    : card.startedBy === undefined
      ? 'ASKED IN THIS THREAD'
      : `ASKED BY ${card.startedBy.displayName.toUpperCase()}`;
  const making = stage === 'making' || stage === 'slow';
  const seconds = madeInSeconds(card);
  return (
    <View style={styles.wrap}>
      {answer.status === 'ready' ? (
        <Text variant="monoXs" color={theme.textQuiet} align="center" testID="what-if-ready-line">
          {`WHAT-IF READY${madeInWords(seconds)} · ${clockTime(new Date(answer.readyAt))}`}
        </Text>
      ) : null}
      <View role="article" accessibilityLabel={answerLabel(card)} style={styles.card} testID="what-if-card">
        <Labels card={card} />
        <Text variant="monoXs" color={universe.ink2}>
          {making ? 'WHAT-IF · MAKING IT' : `${startedLine.toUpperCase()} · ${asker} · CHECKED`}
        </Text>
        <Text variant="title" heading={3} color={universe.ink}>
          {card.title}
        </Text>
        {making ? <Making stage={stage} /> : null}
        {answer.status === 'ready' ? <Answer card={card} answer={answer} /> : null}
        {card.speculative ? (
          <Text variant="uiS" color={universe.ink2}>
            {SPECULATIVE_NOTICE}
          </Text>
        ) : null}
        {openedByYou ? (
          <View style={styles.opened}>
            <Icon name="check" size={14} color={universe.ink2} />
            <Text variant="metaS" color={universe.ink2}>
              Opened by you
            </Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          {making ? (
            starterIsYou ? (
              <Button label="Cancel" variant="ghost" size="sm" onPress={() => onRemove(card)} testID="what-if-cancel" />
            ) : null
          ) : (
            <>
              <FullScroll card={card} onOpen={onOpen} />
              {card.status === 'ready' ? (
                <Button
                  label="Branch again"
                  variant="ghost"
                  size="sm"
                  icon="hypothetical"
                  onPress={() => onContinue(card)}
                  testID="what-if-branch-again"
                />
              ) : null}
              {starterIsYou ? (
                <BranchMenu card={card} starterIsYou withContinue={false} onRemove={onRemove} onContinue={onContinue} />
              ) : null}
            </>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing[2], alignItems: 'center', maxWidth: '100%', width: 340 },
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.panel,
    backgroundColor: universe.paper,
    maxWidth: '100%',
    width: '100%',
    boxShadow: universe.shadow.card,
  },
  labels: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
  label: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: universe.ink,
    backgroundColor: universe.paper2,
  },
  making: { gap: spacing[2] },
  stripe: {
    overflow: 'hidden',
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: universe.ink,
    minHeight: 8,
  },
  body: { gap: spacing[2] },
  line: { gap: spacing[1], paddingHorizontal: spacing[3], paddingVertical: spacing[2], borderRadius: radius.card },
  assumed: { backgroundColor: universe.paper2 },
  changed: { borderWidth: borderWidth.regular, borderColor: universe.cobalt },
  kept: { borderWidth: borderWidth.light, borderColor: universe.ink },
  numbers: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  figure: {
    gap: spacing[1],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.card,
    backgroundColor: universe.paper2,
  },
  opened: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  actions: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap', alignItems: 'center' },
});
