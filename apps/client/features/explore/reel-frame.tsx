import { useState, type ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Tag, Text } from '@knowscroll/ui';
import { EncounterRail } from '../encounter/encounter-actions';
import type { EncounterEntry } from '../encounter/encounter-history';
import type { EncounterSession, EncounterState } from '../encounter/encounter-session';
import { EncounterFormatSwitch } from '../encounter/encounter-top-bar';
import { KeyboardMapSheet } from '../shell/keyboard-map';

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
 * The Reel's column in Explore. `framed` (a desktop, D01) draws the video as a card on the paper
 * ground, the subject buttons and the Reel/Scroll switch above it, the action rail beside it and
 * the next-subject row with the key hints below; the card's size follows the window (explicit, so
 * the player never measures its parent). Unframed it is only the full-bleed column. Both layouts
 * are one element tree with the same slots, so the player and its video survive a resize across
 * the breakpoint. The thread beside the encounter is the shell's `ThreadAside`.
 */
export function ReelFrame({
  entry,
  state,
  session,
  framed,
  areaWidth,
  children,
}: {
  readonly entry: EncounterEntry;
  readonly state: EncounterState;
  readonly session: EncounterSession;
  readonly framed: boolean;
  /** Width of the column this frame fills: the window minus the rail and the thread aside. */
  readonly areaWidth: number;
  /** The Reel itself, drawn `framed` or not to match. */
  readonly children: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const cardHeight = Math.max(MIN_CARD_HEIGHT, height - TOP_ROW - FOOTER_ROW - 2 * VERTICAL_PADDING);
  const cardWidth = Math.min(
    CARD_MAX_WIDTH,
    Math.round(cardHeight * CARD_RATIO),
    Math.max(240, areaWidth - RAIL_ROOM - 2 * spacing[5]),
  );
  const columnWidth = Math.min(areaWidth - 2 * spacing[5], Math.max(cardWidth + RAIL_ROOM, TOP_ROW_MIN_WIDTH));
  const idle = state.phase !== 'active';
  const [keysOpen, setKeysOpen] = useState(false);
  return (
    <View
      testID={framed ? 'explore-desktop-frame' : undefined}
      style={framed ? [styles.column, { width: columnWidth }] : styles.fullColumn}
    >
      {framed ? (
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
      ) : null}
      <View style={framed ? styles.middle : styles.fullMiddle}>
        <View style={framed ? [styles.card, { width: cardWidth, height: cardHeight }] : styles.fullMiddle}>
          {children}
        </View>
        {framed ? (
          <View style={styles.rail}>
            <EncounterRail entry={entry} state={state} session={session} surface="paper" />
          </View>
        ) : null}
      </View>
      {framed ? (
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
          <Button label="All shortcuts" variant="ghost" size="sm" onPress={() => setKeysOpen(true)} />
          <KeyboardMapSheet visible={keysOpen} onClose={() => setKeysOpen(false)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignSelf: 'center', paddingVertical: VERTICAL_PADDING, gap: spacing[3] },
  fullColumn: { flex: 1, minHeight: 0, width: '100%', maxWidth: CARD_MAX_WIDTH },
  fullMiddle: { flex: 1, minHeight: 0 },
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
