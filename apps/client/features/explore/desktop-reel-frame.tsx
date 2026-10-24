import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Tag, Text } from '@knowscroll/ui';
import { EncounterRail } from '../encounter/encounter-actions';
import type { EncounterEntry } from '../encounter/encounter-history';
import type { EncounterSession, EncounterState } from '../encounter/encounter-session';
import { EncounterFormatSwitch } from '../encounter/encounter-top-bar';

/** The Reel is a 9:16 card; it never grows wider than the column the player was drawn for. */
const CARD_RATIO = 9 / 16;
const CARD_MAX_WIDTH = 480;
/** The row above the card and the row below it, with their gaps. */
const TOP_ROW = 72;
const FOOTER_ROW = 72;
const VERTICAL_PADDING = spacing[5];
/** The action rail beside the card, and the gap to it. */
const RAIL_ROOM = 72 + spacing[4];
const MIN_CARD_HEIGHT = 360;
/** The control row above the card needs this much room before it wraps. */
const TOP_ROW_MIN_WIDTH = 600;

/** The keys the stage listens to while it has focus (D01's hint row, spoken as one sentence). */
const KEY_HINTS: readonly { readonly keys: readonly string[]; readonly action: string }[] = [
  { keys: ['↑', '↓'], action: 'subject' },
  { keys: ['←', '→'], action: 'thread' },
  { keys: ['Space'], action: 'play / pause' },
];
const KEY_HINT_SPOKEN =
  'With the video focused: up and down arrow change subject, left and right arrow move along the thread, Space plays or pauses.';

function KeyHints() {
  return (
    <View testID="explore-key-hints" role="group" aria-label={KEY_HINT_SPOKEN} style={styles.hints}>
      {KEY_HINTS.map((hint) => (
        <View key={hint.action} style={styles.hint} aria-hidden>
          {hint.keys.map((key) => (
            <View key={key} style={styles.key}>
              <Text variant="metaS">{key}</Text>
            </View>
          ))}
          <Text variant="meta" color={content.ink2}>
            {hint.action}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A Reel on a desktop (D01): the video is a card on the paper ground, the subject buttons and the
 * Reel/Scroll switch sit above it, the action rail beside it and the next-subject row with the key
 * hints below. The card's size follows the window (explicit, so the player never measures its
 * parent). The thread beside the encounter is the shell's `ThreadAside`.
 */
export function DesktopReelFrame({
  entry,
  state,
  session,
  areaWidth,
  children,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  /** Width of the column this frame fills: the window minus the rail and the thread aside. */
  readonly areaWidth: number;
  /** The Reel itself, drawn `framed`. */
  readonly children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const cardHeight = Math.max(MIN_CARD_HEIGHT, height - TOP_ROW - FOOTER_ROW - 2 * VERTICAL_PADDING);
  const cardWidth = Math.min(
    CARD_MAX_WIDTH,
    Math.round(cardHeight * CARD_RATIO),
    Math.max(240, areaWidth - RAIL_ROOM - 2 * spacing[5]),
  );
  const idle = state.phase !== 'active';
  return (
    <View testID="explore-desktop-frame" style={styles.frame}>
      <View
        style={[
          styles.column,
          { width: Math.min(areaWidth - 2 * spacing[5], Math.max(cardWidth + RAIL_ROOM, TOP_ROW_MIN_WIDTH)) },
        ]}
      >
        <View style={styles.top}>
          <Button
            label="Previous subject"
            icon="arrowUp"
            size="sm"
            disabled={idle}
            onPress={() => session.navigate({ mode: 'vertical', direction: 'previous' })}
          />
          <EncounterFormatSwitch entry={entry} session={session} />
          <IconButton icon="more" label="More options" variant="paper" onPress={() => session.setOverlay(true)} />
          {entry.kind === 'reel' && entry.document.fixture ? <Tag label="Fixture video" variant="neutral" /> : null}
        </View>
        <View style={styles.middle}>
          <View style={[styles.card, { width: cardWidth, height: cardHeight }]}>{children}</View>
          <View style={styles.rail}>
            <EncounterRail entry={entry} state={state} session={session} surface="paper" />
          </View>
        </View>
        <View style={styles.footer}>
          <Button
            label="Next subject"
            icon="arrowDown"
            iconPosition="trailing"
            size="sm"
            disabled={idle}
            onPress={() => session.navigate({ mode: 'vertical', direction: 'next' })}
          />
          <KeyHints />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center' },
  column: { paddingVertical: VERTICAL_PADDING, gap: spacing[3] },
  top: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[3],
    minHeight: TOP_ROW - spacing[3],
  },
  middle: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[4] },
  card: {
    overflow: 'hidden',
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.ink,
    boxShadow: elevation.heroInk,
  },
  rail: { width: RAIL_ROOM - spacing[4] },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing[4], minHeight: FOOTER_ROW - spacing[3] },
  hints: { flexDirection: 'row', alignItems: 'center', gap: spacing[4], flexShrink: 1, flexWrap: 'wrap' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  key: {
    minWidth: 24,
    height: 24,
    paddingHorizontal: spacing['1.5'],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.tag,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
});
