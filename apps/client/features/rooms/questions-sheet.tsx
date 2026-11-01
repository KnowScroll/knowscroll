import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  QUESTION_LEFT_WORDS,
  questionsChip,
  type AccountScope,
  type QuestionLeft,
  type RoomController,
  type RoomState,
} from '@knowscroll/client-core';
import { QUESTION_MAX_LENGTH, QUESTION_MIN_LENGTH, type RoomView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, SwitchRow, Tag, Text } from '@knowscroll/ui';
import { FormField } from './form-field';
import { useRoomTopics } from './use-room';

type Member = Extract<RoomView, { status: 'member' }>;
type Page = 'shelf' | 'compose' | 'left';

/** The shelf of questions that wait for a person (R3 F, "Open questions"): each is a topic no person but its asker has spoken in. */
function Shelf({
  scope,
  view,
  visible,
  onOpen,
  onCompose,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly visible: boolean;
  readonly onOpen: (discussionId: string) => void;
  readonly onCompose: () => void;
}) {
  const topics = useRoomTopics(scope, view.room.roomId, {
    sort: 'unanswered',
    tag: 'question',
    refreshKey: view.questions,
    enabled: visible,
  });
  const chip = questionsChip(view.questions);
  return (
    <View style={styles.body}>
      <Text variant="bodyS" color={content.ink2}>
        A question left here waits for the next person who knows. It stays open until a person answers, whatever a
        resident said, and its asker is told.
      </Text>
      <Text variant="monoXs" color={content.ink2} testID="questions-count">
        {chip === undefined ? 'NO QUESTION IS WAITING' : chip.detail.toUpperCase()}
      </Text>
      <View role="list" accessibilityLabel="Questions waiting for a person" style={styles.rows}>
        {(topics ?? []).map((item) => (
          <View key={item.discussionId} role="listitem">
            <Pressable
              role="link"
              accessibilityLabel={`${item.title}, open for people`}
              onPress={() => onOpen(item.discussionId)}
              style={styles.row}
              testID={`question-${item.discussionId}`}
            >
              <View style={styles.tags}>
                <Tag label="Open for people" />
              </View>
              <Text variant="ui" numberOfLines={3}>
                {item.title}
              </Text>
              {item.startedBy === undefined ? null : (
                <Text variant="metaS" color={content.ink2}>
                  {`Asked by ${item.startedBy.displayName}`}
                </Text>
              )}
            </Pressable>
          </View>
        ))}
      </View>
      <Button
        label="Leave a question"
        variant="primary"
        disabled={!view.canPost}
        onPress={onCompose}
        testID="question-compose"
      />
    </View>
  );
}

/** The words, whether a resident answers now and whether to be told: three choices the asker makes, each on by default but their own. */
function Compose({
  view,
  state,
  onLeft,
  onBack,
  controller,
}: {
  readonly view: Member;
  readonly state: RoomState;
  readonly controller: RoomController;
  readonly onLeft: (left: QuestionLeft) => void;
  readonly onBack: () => void;
}) {
  const [text, setText] = useState('');
  const keptOut = view.you.keepOut;
  const [askNow, setAskNow] = useState(!keptOut);
  const [notify, setNotify] = useState(true);
  const explainer = view.inhabitants.find((entry) => entry.inhabitant === 'explainer');
  const ready = text.trim().length >= QUESTION_MIN_LENGTH && !state.working;
  const leave = () =>
    void controller.leaveQuestion({ text: text.trim(), askNow: askNow && !keptOut, notify }).then((left) => {
      if (left !== undefined) onLeft(left);
    });
  return (
    <View style={styles.body}>
      <FormField
        label="Your question"
        value={text}
        onChange={setText}
        maxLength={QUESTION_MAX_LENGTH}
        multiline
        hint={`At least ${String(QUESTION_MIN_LENGTH)} characters. The room reads it, so leave out anything private.`}
        testID="question-text"
      />
      <SwitchRow
        label={explainer === undefined ? 'Ask a resident to answer now' : `Ask ${explainer.name} to answer now`}
        description={
          keptOut
            ? 'You keep your messages out of what AI reads, so no resident can read this one.'
            : 'It writes an answer straight away and says it is AI. People can still add more.'
        }
        on={askNow && !keptOut}
        onChange={setAskNow}
        disabled={keptOut || explainer === undefined}
      />
      <SwitchRow
        label="Tell me when a person answers"
        description="You are told in this room, once. A resident’s answer never counts."
        on={notify}
        onChange={setNotify}
      />
      {state.refused ? (
        <Text variant="metaS" color={content.ink2} testID="question-refused">
          That didn’t go through. The room may have changed; try again.
        </Text>
      ) : null}
      <Button
        label="Leave the question"
        variant="primary"
        disabled={!ready}
        busy={state.working}
        busyLabel="Leaving"
        onPress={leave}
        testID="question-submit"
      />
      <Button label="Back" variant="ghost" onPress={onBack} />
    </View>
  );
}

/**
 * Questions for people (R3 F frame 3): the shelf of questions still waiting for a person and a way to leave one. Leaving is one
 * tap after the words: a topic tagged Question with its card in General, and, when the asker wants it and the room can, a resident's
 * answer now, labelled AI. Nothing is asked of a model without that choice, and the question stays open for people either way.
 */
export function QuestionsSheet({
  scope,
  view,
  controller,
  state,
  visible,
  onClose,
  onOpen,
}: {
  readonly scope: AccountScope;
  readonly view: Member;
  readonly controller: RoomController;
  readonly state: RoomState;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onOpen: (discussionId: string) => void;
}) {
  const [page, setPage] = useState<Page>('shelf');
  const [left, setLeft] = useState<QuestionLeft>();
  // Every way out goes through here, so the sheet always opens again on the shelf.
  const close = () => {
    setPage('shelf');
    onClose();
  };
  const open = (discussionId: string) => {
    setPage('shelf');
    onOpen(discussionId);
  };
  return (
    <BottomSheet
      visible={visible}
      title={page === 'compose' ? 'Leave a question' : 'Open questions'}
      onClose={close}
      testID="questions-sheet"
    >
      {page === 'shelf' ? (
        <Shelf scope={scope} view={view} visible={visible} onOpen={open} onCompose={() => setPage('compose')} />
      ) : page === 'compose' ? (
        <Compose
          view={view}
          state={state}
          controller={controller}
          onBack={() => setPage('shelf')}
          onLeft={(result) => {
            setLeft(result);
            setPage('left');
          }}
        />
      ) : (
        <View style={styles.body} testID="question-left">
          <Text variant="bodyS">{left === undefined ? '' : QUESTION_LEFT_WORDS[left.asked]}</Text>
          <Text variant="metaS" color={content.ink2}>
            You’ll see it on the shelf of open questions, where the next person here will see it first.
          </Text>
          <Button
            label="Open the question"
            variant="primary"
            onPress={() => left !== undefined && open(left.discussionId)}
            testID="question-open"
          />
          <Button label="Back to the room" variant="ghost" onPress={close} />
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  rows: { gap: spacing[2] },
  tags: { flexDirection: 'row' },
  row: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
});
