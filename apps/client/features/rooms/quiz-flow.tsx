import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ActivityView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Tag, Text } from '@knowscroll/ui';
import { ChoiceRow } from './choice-row';

type Ready = Extract<ActivityView, { status: 'ready' }>;
type Quiz = Extract<Ready['activity'], { kind: 'quiz' }>;

/**
 * R03 "Optional room quiz": one question at a time, then the answers view. What a person picks stays in
 * this component: the server is never told, so there is no score, grade, rank, streak or result to keep,
 * and nothing to resume. Leaving drops the position without a nag, and every exit weighs the same.
 */
export function QuizFlow({
  quiz,
  canDiscuss,
  onDiscuss,
  onDone,
}: {
  readonly quiz: Quiz;
  /** The person may start a discussion in this room (it is open). */
  readonly canDiscuss: boolean;
  readonly onDiscuss: (title: string) => void;
  readonly onDone: () => void;
}) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const total = quiz.questions.length;
  const question = quiz.questions[step];

  if (question === undefined)
    return (
      <View style={styles.card} testID="quiz-answers">
        <View style={styles.tags}>
          <Tag label="Optional" />
          <Tag label="Room quiz · answers" />
        </View>
        <Text variant="title" heading={1}>
          Here’s how each one works out.
        </Text>
        <Text variant="meta" color={content.ink2}>
          Nothing is kept as a result.
        </Text>
        <View role="list" accessibilityLabel="Answers" style={styles.answers}>
          {quiz.questions.map((entry, index) => {
            const picked = entry.options.find((option) => option.optionId === picks[entry.questionId]);
            return (
              <View key={entry.questionId} role="listitem" style={styles.answer}>
                <Text variant="ui">{`${String(index + 1)} · ${entry.explanation.heading}`}</Text>
                <Text variant="bodyS">{entry.explanation.text}</Text>
                {entry.explanation.note === undefined ? null : (
                  <Text variant="meta" color={content.ink2}>
                    {entry.explanation.note}
                  </Text>
                )}
                {picked === undefined ? null : (
                  <Text variant="metaS" color={content.ink2}>
                    {`You picked: ${picked.text}`}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
        <View style={styles.actions}>
          {canDiscuss ? (
            <Button label="Discuss this" onPress={() => onDiscuss(quiz.title)} testID="quiz-discuss" />
          ) : null}
          <Button label="Done" variant="primary" onPress={onDone} testID="quiz-done" />
        </View>
      </View>
    );

  const picked = picks[question.questionId];
  const last = step === total - 1;
  return (
    <View style={styles.card} testID="quiz-question">
      <View style={styles.tags}>
        <Tag label="Optional" />
        <Tag label="Room quiz" />
      </View>
      <Text variant="meta" color={content.ink2}>
        {`${quiz.title} · nothing here shapes your universe. Leave whenever you like.`}
      </Text>
      <Text variant="monoXs" color={content.ink2}>
        {`Question ${String(step + 1)} of ${String(total)}`}
      </Text>
      <Text variant="title" heading={1}>
        {question.prompt}
      </Text>
      <View role="radiogroup" accessibilityLabel={question.prompt} style={styles.options}>
        {question.options.map((option) => (
          <ChoiceRow
            key={option.optionId}
            testID={`quiz-option-${option.optionId}`}
            text={option.text}
            checked={picked === option.optionId}
            onChoose={() => setPicks({ ...picks, [question.questionId]: option.optionId })}
          />
        ))}
      </View>
      <View style={styles.actions}>
        <Button label="Skip question" variant="ghost" onPress={() => setStep(step + 1)} testID="quiz-skip" />
        <Button
          label={last ? 'See answers' : 'Next'}
          variant="primary"
          disabled={picked === undefined}
          onPress={() => setStep(step + 1)}
          testID="quiz-next"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.lg,
    backgroundColor: content.paper,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  options: { gap: spacing[2] },
  answers: { gap: spacing[3] },
  answer: {
    gap: spacing['1'],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.light,
    borderColor: content.rule,
    backgroundColor: content.paper2,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing[3] },
});
