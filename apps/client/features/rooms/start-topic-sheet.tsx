import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NewDebate, RoomTopicTag } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text } from '@knowscroll/ui';
import { TAGS, TAG_WORDS, TOPIC_TITLE_MAX } from './ask-words';
import { FormField } from './form-field';

/**
 * Starting a topic (R3 B1): from a message, whose words become its first item and whose first words are the title to
 * edit, or from nothing ("New topic" in the list). A tag is optional and one of four; tapping the chosen one again lets it
 * go. The Debate tag asks for two sides and a time to close, and is offered only for a topic that begins from nothing (a
 * debate has no first message). Starting is conversation: it creates no evidence and changes no one's universe.
 */
export function StartTopicSheet(props: {
  readonly visible: boolean;
  /** The words the topic begins with, shown above the title; none for a topic started from nothing. */
  readonly from?: string;
  readonly suggestedTitle: string;
  readonly working: boolean;
  readonly onClose: () => void;
  readonly onStart: (title: string, tag: RoomTopicTag | undefined, debate?: NewDebate) => void;
}) {
  return (
    <BottomSheet visible={props.visible} title="Start a topic" onClose={props.onClose} testID="start-topic-sheet">
      {/* A new message, or opening the sheet again, brings its own title and a clean tag. */}
      <StartTopicForm key={props.suggestedTitle} {...props} />
    </BottomSheet>
  );
}

function StartTopicForm({
  from,
  suggestedTitle,
  working,
  onClose,
  onStart,
}: {
  readonly from?: string;
  readonly suggestedTitle: string;
  readonly working: boolean;
  readonly onClose: () => void;
  readonly onStart: (title: string, tag: RoomTopicTag | undefined, debate?: NewDebate) => void;
}) {
  const [title, setTitle] = useState(suggestedTitle);
  const [tag, setTag] = useState<RoomTopicTag>();
  const [sides, setSides] = useState<[string, string]>(['', '']);
  const [hours, setHours] = useState<number>(24);
  const debating = tag === 'debate';
  const trimmed: [string, string] = [sides[0].trim(), sides[1].trim()];
  const ready =
    title.trim() !== '' &&
    (!debating || (trimmed[0] !== '' && trimmed[1] !== '' && trimmed[0].toLowerCase() !== trimmed[1].toLowerCase()));
  const start = () =>
    debating ? onStart(title.trim(), tag, { sides: trimmed, closesInHours: hours }) : onStart(title.trim(), tag);
  return (
    <View style={styles.body}>
      {from === undefined ? null : (
        <View style={styles.quote}>
          <Text variant="metaS" color={content.ink2}>
            It begins with this message
          </Text>
          <Text variant="bodyS" numberOfLines={3}>
            {from}
          </Text>
        </View>
      )}
      <FormField
        label="Title"
        value={title}
        maxLength={TOPIC_TITLE_MAX}
        onChange={setTitle}
        testID="start-topic-title"
      />
      <View role="radiogroup" accessibilityLabel="Tag" style={styles.tags}>
        {(from === undefined ? TAGS : TAGS.filter((entry) => entry !== 'debate')).map((entry) => {
          const selected = entry === tag;
          return (
            <Pressable
              key={entry}
              role="radio"
              aria-checked={selected}
              accessibilityState={{ checked: selected }}
              onPress={() => setTag(selected ? undefined : entry)}
              style={[styles.tag, selected ? styles.tagOn : null]}
              testID={`start-topic-tag-${entry}`}
            >
              <Text variant="ui" color={selected ? content.onAccent : content.ink}>
                {TAG_WORDS[entry]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {debating ? (
        <View style={styles.body} testID="start-debate">
          <FormField
            label="Side one"
            value={sides[0]}
            maxLength={SIDE_MAX}
            onChange={(text) => setSides([text, sides[1]])}
            testID="start-debate-a"
          />
          <FormField
            label="Side two"
            value={sides[1]}
            maxLength={SIDE_MAX}
            onChange={(text) => setSides([sides[0], text])}
            testID="start-debate-b"
          />
          <View role="radiogroup" accessibilityLabel="Closes after" style={styles.tags}>
            {DEBATE_HOURS.map((entry) => {
              const selected = entry.hours === hours;
              return (
                <Pressable
                  key={entry.hours}
                  role="radio"
                  aria-checked={selected}
                  accessibilityState={{ checked: selected }}
                  onPress={() => setHours(entry.hours)}
                  style={[styles.tag, selected ? styles.tagOn : null]}
                  testID={`start-debate-hours-${String(entry.hours)}`}
                >
                  <Text variant="ui" color={selected ? content.onAccent : content.ink}>
                    {entry.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text variant="metaS" color={content.ink2}>
            Everyone in the room can vote, and change their vote, until it closes. Two or more voters earn the room a
            star.
          </Text>
        </View>
      ) : null}
      <Text variant="metaS" color={content.ink2}>
        Topics live in the room’s list. The message stays where it was, and a card there keeps up with the topic.
      </Text>
      <Button
        label="Start topic"
        variant="primary"
        disabled={!ready}
        busy={working}
        busyLabel="Starting"
        onPress={start}
        testID="start-topic-submit"
      />
      <Button label="Cancel" variant="ghost" onPress={onClose} />
    </View>
  );
}

/** The longest a side of a debate is: the server's limit. */
const SIDE_MAX = 60;
/** How long a debate runs: four choices, so there is nothing to type and nothing to get wrong. */
const DEBATE_HOURS = [
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
] as const;

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  quote: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.rule,
    borderRadius: radius.md,
    backgroundColor: content.paper2,
  },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  tag: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.pill,
    backgroundColor: content.paper,
  },
  tagOn: { backgroundColor: content.accent },
});
