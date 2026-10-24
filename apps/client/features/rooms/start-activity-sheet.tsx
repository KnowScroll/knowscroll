import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { RoomActivitiesController, RoomActivitiesState } from '@knowscroll/client-core';
import type { NewActivity } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Banner, Button, Text } from '@knowscroll/ui';
import { FormField } from './form-field';

const MAX_POLL_OPTIONS = 5;
const MAX_QUIZ_QUESTIONS = 5;
const MAX_QUIZ_OPTIONS = 4;

const trimmed = (values: readonly string[]) => values.map((value) => value.trim());
const distinct = (values: readonly string[]) =>
  new Set(values.map((value) => value.toLowerCase())).size === values.length;

/** A poll draft is ready when it has a question and two to five different, non-empty options. */
export function pollDraft(prompt: string, options: readonly string[]): NewActivity | undefined {
  const texts = trimmed(options).filter((option) => option !== '');
  if (prompt.trim() === '' || texts.length < 2 || !distinct(texts)) return undefined;
  return { kind: 'poll', prompt: prompt.trim(), options: texts };
}

interface QuestionDraft {
  prompt: string;
  options: readonly string[];
  heading: string;
  text: string;
  note: string;
}
const blankQuestion = (): QuestionDraft => ({ prompt: '', options: ['', ''], heading: '', text: '', note: '' });

/** A quiz draft is ready when every question has its words, two to four different options and an explanation. */
export function quizDraft(title: string, questions: readonly QuestionDraft[]): NewActivity | undefined {
  if (title.trim() === '' || questions.length === 0) return undefined;
  const built: Extract<NewActivity, { kind: 'quiz' }>['questions'] = [];
  for (const question of questions) {
    const options = trimmed(question.options).filter((option) => option !== '');
    if (
      question.prompt.trim() === '' ||
      options.length < 2 ||
      !distinct(options) ||
      question.heading.trim() === '' ||
      question.text.trim() === ''
    )
      return undefined;
    built.push({
      prompt: question.prompt.trim(),
      options,
      explanation: {
        heading: question.heading.trim(),
        text: question.text.trim(),
        ...(question.note.trim() === '' ? {} : { note: question.note.trim() }),
      },
    });
  }
  return { kind: 'quiz', title: title.trim(), questions: built };
}

function PollForm({ onDraft }: { readonly onDraft: (draft: NewActivity | undefined) => void }) {
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<readonly string[]>(['', '']);
  const update = (nextPrompt: string, nextOptions: readonly string[]) => {
    setPrompt(nextPrompt);
    setOptions(nextOptions);
    onDraft(pollDraft(nextPrompt, nextOptions));
  };
  return (
    <View style={styles.form}>
      <FormField
        label="Question"
        value={prompt}
        maxLength={160}
        onChange={(text) => update(text, options)}
        testID="poll-prompt"
      />
      {options.map((option, index) => (
        <FormField
          key={String(index)}
          label={`Option ${String(index + 1)}`}
          value={option}
          maxLength={80}
          onChange={(text) =>
            update(
              prompt,
              options.map((entry, at) => (at === index ? text : entry)),
            )
          }
          testID={`poll-option-field-${String(index + 1)}`}
        />
      ))}
      {options.length < MAX_POLL_OPTIONS ? (
        <Button label="Add an option" size="sm" variant="ghost" onPress={() => update(prompt, [...options, ''])} />
      ) : null}
    </View>
  );
}

function QuizForm({ onDraft }: { readonly onDraft: (draft: NewActivity | undefined) => void }) {
  const [title, setTitle] = useState('');
  const [questions, setQuestions] = useState<readonly QuestionDraft[]>([blankQuestion()]);
  const update = (nextTitle: string, nextQuestions: readonly QuestionDraft[]) => {
    setTitle(nextTitle);
    setQuestions(nextQuestions);
    onDraft(quizDraft(nextTitle, nextQuestions));
  };
  const change = (index: number, patch: Partial<QuestionDraft>) =>
    update(
      title,
      questions.map((question, at) => (at === index ? { ...question, ...patch } : question)),
    );
  return (
    <View style={styles.form}>
      <FormField
        label="Quiz title"
        value={title}
        maxLength={160}
        onChange={(text) => update(text, questions)}
        testID="quiz-title"
      />
      {questions.map((question, index) => (
        <View key={String(index)} style={styles.question}>
          <Text variant="monoXs" color={content.ink2}>{`Question ${String(index + 1)}`}</Text>
          <FormField
            label={`Question ${String(index + 1)} text`}
            value={question.prompt}
            maxLength={160}
            onChange={(text) => change(index, { prompt: text })}
          />
          {question.options.map((option, at) => (
            <FormField
              key={String(at)}
              label={`Question ${String(index + 1)} option ${String(at + 1)}`}
              value={option}
              maxLength={80}
              onChange={(text) =>
                change(index, { options: question.options.map((entry, i) => (i === at ? text : entry)) })
              }
            />
          ))}
          {question.options.length < MAX_QUIZ_OPTIONS ? (
            <Button
              label="Add an option"
              size="sm"
              variant="ghost"
              onPress={() => change(index, { options: [...question.options, ''] })}
            />
          ) : null}
          <FormField
            label={`Question ${String(index + 1)} answer, heading`}
            value={question.heading}
            maxLength={80}
            onChange={(text) => change(index, { heading: text })}
          />
          <FormField
            label={`Question ${String(index + 1)} answer, explanation`}
            value={question.text}
            maxLength={240}
            multiline
            onChange={(text) => change(index, { text })}
          />
          <FormField
            label={`Question ${String(index + 1)} answer, a short note (optional)`}
            value={question.note}
            maxLength={160}
            onChange={(text) => change(index, { note: text })}
          />
        </View>
      ))}
      {questions.length < MAX_QUIZ_QUESTIONS ? (
        <Button
          label="Add a question"
          size="sm"
          variant="ghost"
          onPress={() => update(title, [...questions, blankQuestion()])}
        />
      ) : null}
    </View>
  );
}

/**
 * A moderator starts a poll or a quiz (R03). The form is the whole of it: no timer, no points, no
 * audience choice. The result is a message-free activity inside this room, and nothing is announced
 * outside it.
 */
export function StartActivitySheet(props: StartActivitySheetProps) {
  // Each kind starts from a blank form, so a draft never carries over from the other.
  return <ActivitySheet key={props.kind ?? 'closed'} {...props} />;
}

interface StartActivitySheetProps {
  readonly kind: 'poll' | 'quiz' | undefined;
  readonly controller: RoomActivitiesController;
  readonly state: RoomActivitiesState;
  readonly onClose: () => void;
  /** Called once the activity exists; the sheet is closed first. */
  readonly onStarted: (activityId: string) => void;
}

function ActivitySheet({ kind, controller, state, onClose, onStarted }: StartActivitySheetProps) {
  const [draft, setDraft] = useState<NewActivity>();
  const visible = kind !== undefined;
  return (
    <BottomSheet visible={visible} title={kind === 'quiz' ? 'Start a quiz' : 'Start a poll'} onClose={onClose}>
      <ScrollView contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
        {kind === 'poll' ? <PollForm key="poll" onDraft={setDraft} /> : null}
        {kind === 'quiz' ? <QuizForm key="quiz" onDraft={setDraft} /> : null}
        <Text variant="meta" color={content.ink2}>
          Members can skip it, and nothing about it changes anyone’s universe. It stays in this room.
        </Text>
        {state.refused ? (
          <Banner
            kind="error"
            lead="Couldn’t start it."
            message="The room has changed, or it already has enough open."
          />
        ) : null}
        {state.offline && !state.working ? (
          <Banner kind="offline" lead="Offline." message="It hasn’t been sent. Try again when you’re back online." />
        ) : null}
        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label={kind === 'quiz' ? 'Start quiz' : 'Start poll'}
            variant="primary"
            disabled={draft === undefined}
            busy={state.working}
            busyLabel="Starting"
            testID="start-activity"
            onPress={() => {
              if (draft === undefined) return;
              void controller.create(draft).then((activityId) => {
                if (activityId !== undefined) onStarted(activityId);
              });
            }}
          />
        </View>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: spacing[3], paddingBottom: spacing[4] },
  form: { gap: spacing[3] },
  question: { gap: spacing[2], paddingTop: spacing[2] },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing[3] },
});
