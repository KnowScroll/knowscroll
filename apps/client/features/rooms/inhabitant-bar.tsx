import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { InhabitantStatus } from '@knowscroll/client-core';
import type { InhabitantId } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

const WORDS = {
  available: undefined,
  preparing: 'is preparing a reply',
  resting: 'is resting for today',
  paused: 'is quiet while the room is paused',
} as const;

/**
 * Asking a resident: one button for each labelled AI resident, with its name and the honest reason when it cannot be
 * asked (a reply is being prepared, the bound is used, the room is paused). The text says what a resident is and is
 * not: a suggestion, never a person, and nothing is made unless someone chooses it. What residents read is said once,
 * when a member joins, and after that in the room menu under AI here, not on every visit.
 *
 * On a phone the panel starts as one line naming the residents, so the messages keep the screen; a tap opens it
 * and a tap closes it again.
 */
export function InhabitantBar({
  inhabitants,
  asking,
  outcome,
  onAsk,
  compact,
  collapsible,
}: {
  /** Starts as one line that opens and closes the panel, where the screen is too short to keep it open. */
  readonly collapsible?: boolean;
  /** One line of labels and buttons instead of a row each, where height is short (D04's centre pane). */
  readonly compact?: boolean;
  readonly inhabitants: readonly InhabitantStatus[];
  readonly asking: boolean;
  /** The words for the last ask that did not become a request or a reply. */
  readonly outcome: string | undefined;
  readonly onAsk: (inhabitant: InhabitantId) => void;
}) {
  const [open, setOpen] = useState(false);
  if (inhabitants.length === 0) return null;
  const shut = collapsible === true && !open;
  const names = inhabitants.map((entry) => entry.name).join(', ');
  return (
    <View style={shut ? styles.shut : styles.bar} accessibilityLabel="AI inhabitants">
      {collapsible === true ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`AI residents: ${names}. ${open ? 'Hide how to ask' : 'Show how to ask'}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          style={styles.toggle}
          testID="inhabitants-toggle"
        >
          <View style={styles.toggleText}>
            <Text variant="ui" numberOfLines={1}>
              {`AI residents · ${names}`}
            </Text>
          </View>
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={20} />
        </Pressable>
      ) : null}
      {shut ? null : (
        <Panel inhabitants={inhabitants} asking={asking} onAsk={onAsk} compact={compact === true} />
      )}
      {outcome === undefined ? null : (
        <View accessibilityLiveRegion="polite">
          <Text variant="metaS">{outcome}</Text>
        </View>
      )}
    </View>
  );
}

function Panel({
  inhabitants,
  asking,
  onAsk,
  compact,
}: {
  readonly inhabitants: readonly InhabitantStatus[];
  readonly asking: boolean;
  readonly onAsk: (inhabitant: InhabitantId) => void;
  readonly compact: boolean;
}) {
  return (
    <>
      <Text variant="metaS" color={content.ink2}>
        AI residents answer when asked: tap Ask, or name one in a message{' '}
        {inhabitants[0] === undefined ? '' : `(@${inhabitants[0].name})`}. If a question goes unanswered for a while,
        one may join in, within limits.
      </Text>
      <View style={compact ? styles.compact : styles.list}>
        {inhabitants.map((entry) => {
          const reason = WORDS[entry.ask];
          return (
            <View key={entry.inhabitant} style={compact ? styles.compactRow : styles.row}>
              <View style={compact ? styles.compactWho : styles.who}>
                <Text variant="ui">{entry.name}</Text>
                <AiLabel label={entry.label} />
                {compact && reason === undefined ? null : (
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
    </>
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
  shut: {
    marginHorizontal: layout.gutter,
    paddingHorizontal: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderStyle: 'dashed',
    borderRadius: radius.card,
    backgroundColor: content.paper,
  },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[2], minHeight: 44 },
  toggleText: { flexShrink: 1 },
  list: { gap: spacing[2] },
  compact: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[4] },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  compactWho: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  who: { flex: 1, gap: spacing['0.5'] },
});
