import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';
import { keepingNote } from './call-state';
import { dataSet } from './data-set';
import type { Payoff } from './payoff';
import { PlayChip } from './play-chips';
import type { StageLandmark } from './stage-play';

/** The score row of the payoff: the sparks of this Scroll, the best combo from two, and how the Final call went. */
export function ScoreRow({ payoff }: { readonly payoff: Payoff }) {
  const sparks = payoff.sparks === 1 ? '1 spark' : `${String(payoff.sparks)} sparks`;
  return (
    <View style={styles.chips} testID="payoff-score">
      <PlayChip label={sparks} tone="earned" />
      {payoff.bestCombo >= 2 ? <PlayChip label={`Combo ×${String(payoff.bestCombo)}`} tone="earned" /> : null}
      {payoff.final === 'right' ? <PlayChip label="Final call ✓" tone="called_it" /> : null}
      {payoff.final === 'wrong' ? <PlayChip label="Final call · Plot twist" tone="plot_twist" /> : null}
      {payoff.final === 'open' ? <PlayChip label="Final call · still open" tone="plot_twist" /> : null}
    </View>
  );
}

/**
 * The landmark this Scroll awarded (D-188): gold for a right Final call, plain for any other, each
 * with its name. It says nothing a score would: no points, no rank. When the lock was not kept (recording
 * paused, no connection) the card says so in the reader's own words.
 */
export function LandmarkCard({
  landmark,
  note,
}: {
  readonly landmark: StageLandmark;
  /** Why the landmark is not kept, when it is not. */
  readonly note: string | undefined;
}) {
  const gold = landmark.tier === 'gold';
  return (
    <View
      testID="landmark-card"
      role="group"
      aria-label={`${gold ? 'Gold landmark' : 'Landmark'}: ${landmark.name}`}
      style={[styles.card, gold ? styles.gold : styles.plain]}
      {...dataSet({ ksLandmarkTier: landmark.tier })}
    >
      <Tag label={gold ? 'Gold landmark' : 'Landmark'} variant={gold ? 'part' : 'neutral'} />
      <Text variant="title" heading={3}>
        {landmark.name}
      </Text>
      <Text variant="meta" color={content.ink2}>
        {gold ? 'Gold finish, first try.' : 'Plain finish.'}
      </Text>
      {note === undefined ? null : (
        <Text variant="meta" color={content.ink2} testID="landmark-note">
          {note}
        </Text>
      )}
    </View>
  );
}

/** What the payoff says about whether the Final call, and so the landmark, was kept. */
export function landmarkNoteOf(payoff: Payoff): string | undefined {
  return payoff.keeping === undefined ? undefined : keepingNote(payoff.keeping);
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  card: {
    alignSelf: 'stretch',
    gap: spacing[2],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderRadius: radius.panel,
    backgroundColor: content.paper,
  },
  gold: { borderWidth: borderWidth.current, borderColor: content.ink, backgroundColor: content.highlight },
  plain: { borderWidth: borderWidth.regular, borderColor: content.ink },
});
