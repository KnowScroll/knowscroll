import { StyleSheet, View } from 'react-native';
import type { RoomDebate } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Tag, Text } from '@knowscroll/ui';
import { ChoiceRow } from './choice-row';
import { closesWords } from './today-words';

const SIDES = ['a', 'b'] as const;

/** A side's tally under its words; present only once the reader has voted or the debate closed (the server holds it back). */
function Tally({ votes, total }: { readonly votes: number; readonly total: number }) {
  const share = total === 0 ? 0 : Math.round((votes / total) * 100);
  return (
    <View style={styles.result} aria-hidden>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${String(share)}%` }]} />
      </View>
      <Text variant="metaS" color={content.ink2}>{`${String(votes)} ${votes === 1 ? 'vote' : 'votes'}`}</Text>
    </View>
  );
}

/**
 * A debate's card (R3 E "Debate + vote"): two sides, a close time and one vote that can change until then. Counts come from
 * the server once the reader has voted or it closed, so seeing a count never comes before choosing; they say how many chose a
 * side and never who. A tie has no winner. Closing with two or more different voters earns the room a star.
 */
export function DebateCard({
  debate,
  canVote,
  refused = false,
  onVote,
}: {
  readonly debate: RoomDebate;
  /** The last vote was not kept: the debate closed, or the room stopped taking posts, or the vote did not reach the room. */
  readonly refused?: boolean;
  /** The room takes posts: a paused or closed room reads the debate but cannot vote. */
  readonly canVote: boolean;
  readonly onVote: (side: 'a' | 'b') => void;
}) {
  const closed = debate.state === 'closed';
  const counted = debate.sides.every((side) => side.votes !== undefined);
  const total = debate.sides.reduce((sum, side) => sum + (side.votes ?? 0), 0);
  return (
    <View style={styles.card} testID="debate-card">
      <View style={styles.tags}>
        <Tag label="Debate" />
        <Tag label={closed ? 'Closed' : `Closes ${closesWords(debate.closesAt)}`} />
      </View>
      <View role="radiogroup" accessibilityLabel="Your vote" style={styles.options}>
        {SIDES.map((key, index) => {
          const side = debate.sides[index]!;
          const spoken =
            side.votes === undefined
              ? side.text
              : `${side.text}, ${String(side.votes)} ${side.votes === 1 ? 'vote' : 'votes'}`;
          return (
            <ChoiceRow
              key={key}
              testID={`debate-side-${key}`}
              text={side.text}
              accessibilityLabel={debate.winner === key ? `${spoken}, won` : spoken}
              checked={debate.yourVote === key}
              disabled={closed || !canVote}
              onChoose={() => onVote(key)}
              {...(counted ? { detail: <Tally votes={side.votes ?? 0} total={total} /> } : {})}
            />
          );
        })}
      </View>
      <Text variant="metaS" color={content.ink2} testID="debate-note">
        {closed
          ? debate.winner === undefined
            ? 'It closed level: no side won.'
            : `${debate.sides[debate.winner === 'a' ? 0 : 1].text} won the vote.`
          : debate.yourVote === undefined
            ? 'Choose a side to see how the room is voting.'
            : 'Your vote is yours to change until it closes.'}
      </Text>
      {refused ? (
        <Banner
          kind="error"
          lead="Your vote wasn’t kept."
          message="The debate may have closed, or the message didn’t get through. Here is how it stands now."
          testID="debate-refused"
        />
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
  result: { gap: spacing['1'] },
  bar: { height: 10, borderRadius: 5, borderWidth: borderWidth.light, borderColor: content.ink, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: content.accent },
});
