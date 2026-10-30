import { StyleSheet, View } from 'react-native';
import type { InhabitantStatus } from '@knowscroll/client-core';
import type { InhabitantId } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

const WORDS = {
  available: undefined,
  preparing: 'is preparing a reply',
  resting: 'is resting for today',
  paused: 'is quiet while the room is paused',
} as const;

/**
 * The only way an AI inhabitant speaks: a member asks. One button for each labelled inhabitant, with
 * the honest reason when it cannot be asked (a reply is being prepared, the daily bound is used, the
 * room is paused). The text says what an inhabitant is and is not: a suggestion, never a person, and
 * nothing is made unless someone chooses it. What asking sends is said once, when a member joins, and
 * after that in the room menu under AI here, not on every visit.
 */
export function InhabitantBar({
  inhabitants,
  asking,
  outcome,
  onAsk,
  compact,
}: {
  /** One line of labels and buttons instead of a row each, where height is short (D04's centre pane). */
  readonly compact?: boolean;
  readonly inhabitants: readonly InhabitantStatus[];
  readonly asking: boolean;
  /** The words for the last ask that did not become a request or a reply. */
  readonly outcome: string | undefined;
  readonly onAsk: (inhabitant: InhabitantId) => void;
}) {
  if (inhabitants.length === 0) return null;
  return (
    <View style={styles.bar} accessibilityLabel="AI inhabitants">
      <Text variant="metaS" color={content.ink2}>
        AI inhabitants speak when someone asks. They won’t fill the room on their own.
      </Text>
      <View style={compact === true ? styles.compact : styles.list}>
        {inhabitants.map((entry) => {
          const reason = WORDS[entry.ask];
          return (
            <View key={entry.inhabitant} style={compact === true ? styles.compactRow : styles.row}>
              <View style={compact === true ? styles.compactWho : styles.who}>
                <AiLabel label={entry.label} />
                {compact === true && reason === undefined ? null : (
                  <Text variant="meta" color={content.ink2} numberOfLines={1}>
                    {reason === undefined ? entry.blurb : reason}
                  </Text>
                )}
              </View>
              <Button
                label="Ask"
                size="sm"
                accessibilityLabel={`Ask ${entry.label.replace(/\s·\s/g, ', ')}`}
                disabled={entry.ask !== 'available'}
                busy={asking}
                busyLabel="Asking"
                onPress={() => onAsk(entry.inhabitant)}
                testID={`ask-${entry.inhabitant}`}
              />
            </View>
          );
        })}
      </View>
      {outcome === undefined ? null : (
        <View accessibilityLiveRegion="polite">
          <Text variant="metaS">{outcome}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    gap: spacing[2],
    padding: spacing[3],
    marginHorizontal: layout.gutter,
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderStyle: 'dashed',
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  list: { gap: spacing[2] },
  compact: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[4] },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  compactWho: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  who: { flex: 1, gap: spacing['0.5'] },
});
