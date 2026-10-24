import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { RoomActivityController, RoomActivityState } from '@knowscroll/client-core';
import type { ActivityView } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Tag, Text } from '@knowscroll/ui';
import { ChoiceRow } from './choice-row';

type Ready = Extract<ActivityView, { status: 'ready' }>;
type Poll = Extract<Ready['activity'], { kind: 'poll' }>;

/** What a tally adds under an option: its count, a bar and the first voters by name (a vote is visible to the room). */
function Tally({ option, total }: { readonly option: Poll['options'][number]; readonly total: number }) {
  const votes = option.votes ?? 0;
  const named = (option.voters ?? []).map((voter) => voter.displayName);
  const more = votes - named.length;
  const who = [...named, ...(more > 0 ? [`${String(more)} more`] : [])].join(', ');
  const share = total === 0 ? 0 : Math.round((votes / total) * 100);
  return (
    <View style={styles.result} aria-hidden>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${String(share)}%` }]} />
      </View>
      <Text variant="metaS" color={content.ink2}>
        {`${String(votes)} ${votes === 1 ? 'vote' : 'votes'}${who === '' ? '' : ` · ${who}`}`}
      </Text>
    </View>
  );
}

/** The spoken name of an option with its tally, since the visible tally is decoration for the row. */
function spoken(option: Poll['options'][number], showResults: boolean): string {
  if (!showResults) return option.text;
  const votes = option.votes ?? 0;
  const who = (option.voters ?? []).map((voter) => voter.displayName);
  const more = votes - who.length;
  return `${option.text}, ${String(votes)} ${votes === 1 ? 'vote' : 'votes'}${
    who.length === 0 ? '' : `, ${[...who, ...(more > 0 ? [`${String(more)} more`] : [])].join(', ')}`
  }`;
}

/**
 * R03 "Moderator poll": one question, pick one, vote. The vote is visible to the room and can be changed
 * until the moderator closes the poll. Results come from the server once the person has voted or the poll is
 * closed, so seeing others' votes never comes before choosing. Nothing here is required or scored; skipping changes
 * nothing for anyone. `compact` is the card in D04's side panel.
 */
export function PollCard({
  view,
  poll,
  state,
  controller,
  compact,
  onSkip,
}: {
  readonly view: Ready;
  readonly poll: Poll;
  readonly state: RoomActivityState;
  readonly controller: RoomActivityController;
  readonly compact?: boolean;
  readonly onSkip?: () => void;
}) {
  const [picked, setPicked] = useState<string | undefined>(poll.yourVote);
  const choice = picked ?? poll.yourVote;
  const closed = view.state === 'closed';
  // The server decides: it sends a tally only once the person has voted or the poll is closed.
  const showResults = poll.resultsVisible;
  const total = poll.options.reduce((sum, option) => sum + (option.votes ?? 0), 0);
  const send = (optionId: string) => void controller.vote(optionId);
  return (
    <View style={styles.card} testID="poll-card">
      <View style={styles.tags}>
        <Tag label="Optional" />
        <Tag label={closed ? 'Closed' : 'Moderator poll'} />
      </View>
      <Text variant={compact === true ? 'ui' : 'title'} heading={compact === true ? 3 : 1}>
        {poll.prompt}
      </Text>
      {closed ? null : (
        <Text variant="meta" color={content.ink2}>
          Pick one
        </Text>
      )}
      <View role="radiogroup" accessibilityLabel={poll.prompt} style={styles.options}>
        {poll.options.map((option) => (
          <ChoiceRow
            key={option.optionId}
            testID={`poll-option-${option.optionId}`}
            text={option.text}
            accessibilityLabel={spoken(option, showResults)}
            checked={choice === option.optionId}
            disabled={!poll.canVote}
            onChoose={() => setPicked(option.optionId)}
            {...(showResults ? { detail: <Tally option={option} total={total} /> } : {})}
          />
        ))}
      </View>
      <Text variant="metaS" color={content.ink2}>
        {closed
          ? 'This poll is closed. Votes are shown with the names of the people who voted.'
          : 'Your vote is visible to the room. You can change it until the poll closes.'}
      </Text>
      {state.notSent === undefined ? null : (
        <Banner
          kind="offline"
          lead="Not sent yet."
          message="Your vote hasn’t reached the room. Send it again when you’re back online."
        />
      )}
      {state.refused ? (
        <Banner kind="error" lead="Couldn’t vote." message="The poll has changed. Here is how it stands now." />
      ) : null}
      {poll.canVote ? (
        <View style={styles.actions}>
          {compact === true || onSkip === undefined ? null : (
            <Button label="Skip" variant="ghost" onPress={onSkip} testID="poll-skip" />
          )}
          <Button
            label={poll.yourVote === undefined ? 'Vote' : 'Change vote'}
            variant="primary"
            disabled={choice === undefined || choice === poll.yourVote}
            busy={state.working}
            busyLabel="Sending"
            onPress={() => {
              if (choice !== undefined) send(choice);
            }}
            testID="poll-vote"
          />
        </View>
      ) : null}
      {compact === true ? (
        <Text variant="metaS" color={content.ink2}>
          Skipping it changes nothing for you.
        </Text>
      ) : null}
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
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing[3] },
  result: { gap: spacing['1'] },
  bar: { height: 10, borderRadius: 5, borderWidth: borderWidth.light, borderColor: content.ink, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: content.accent },
});
