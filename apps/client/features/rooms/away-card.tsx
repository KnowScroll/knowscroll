import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { dayLabel } from '@knowscroll/client-core';
import type { RoomAway } from '@knowscroll/contracts';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { AiLabel } from './ai-label';

const clockOf = (at: Date): string =>
  at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * "While you were away" (R3 frame 5, T3 question 15): a resident's own recap for someone who came back to a busy room,
 * written once for everyone who came back in the same window. It is labelled as the resident's, says when it starts
 * and goes when the member says they have read it. A Quieter member sees one line until they ask for the words. While
 * the resident is still writing, it says so and nothing more.
 */
export function AwayCard({
  away,
  now,
  busy,
  onDismiss,
}: {
  readonly away: RoomAway;
  readonly now: Date;
  readonly busy: boolean;
  readonly onDismiss: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const since = new Date(away.since);
  const when = `${dayLabel(since, now)} ${clockOf(since)}`;
  const folded = away.folded === true && !opened;
  return (
    <View style={styles.card} testID="away-card" role="region" accessibilityLabel="While you were away">
      <View style={styles.head}>
        <Text variant="ui">{away.resident.name}</Text>
        <AiLabel label={away.resident.label} />
      </View>
      {away.state === 'preparing' ? (
        <Text variant="bodyS" color={content.ink2} testID="away-preparing">
          {`${away.resident.name} is catching you up on what was said since ${when}…`}
        </Text>
      ) : folded ? (
        <View style={styles.head}>
          <Text variant="metaS" color={content.ink2}>
            {`${away.resident.name} caught you up.`}
          </Text>
          <Button label="Show" size="sm" variant="ghost" onPress={() => setOpened(true)} testID="away-show" />
        </View>
      ) : (
        <>
          <Text variant="metaS" color={content.ink2}>
            {`While you were away, since ${when}`}
          </Text>
          <Text variant="bodyS" selectable testID="away-text">
            {away.text}
          </Text>
        </>
      )}
      <Text variant="metaS" color={content.ink2}>
        Written once for everyone who came back in this window. It reads only what the room said, without names.
      </Text>
      <Button label="Got it" size="sm" variant="primary" busy={busy} onPress={onDismiss} testID="away-dismiss" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[2],
    padding: spacing[3],
    marginHorizontal: layout.gutter,
    marginTop: spacing[2],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderStyle: 'dotted',
    borderTopLeftRadius: radius.xs,
    borderRadius: radius.card,
    backgroundColor: content.paper,
    alignItems: 'flex-start',
  },
  head: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing[2] },
});
