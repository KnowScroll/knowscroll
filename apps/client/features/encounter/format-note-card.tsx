import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View, type ViewInstance } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text } from '@knowscroll/ui';
import { keptWords, type FormatNote } from './format-note';

/** How long the card stays before it puts itself away: long enough to read it and choose. */
const NOTE_MS = 9_000;

function KeyChip({ name }: { readonly name: string }) {
  return (
    <View style={styles.key} aria-hidden>
      <Text variant="monoXs">{name}</Text>
    </View>
  );
}

/** Hands focus back to the reader once the note has gone, so the keys of the reader work again (web). */
function returnFocusToReader(): void {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  document.querySelector<HTMLElement>('[data-testid="scroll-reader"]')?.focus();
}

/**
 * "Next topic · as a Scroll" (V3 G4): said once, over the top of the Scroll that Next ↑ landed on, with the topic's title and
 * what the document itself says about it, the way to the Reel of the same topic when there is one, and Undo, which goes back to
 * the Scroll that was left, kept as it was. F and Esc do the two, from the note itself: focus moves into it when it appears,
 * so the keys act at once, and goes back to the reader when it goes. It puts itself away after nine seconds, but not while it
 * has focus or the pointer is over it (WCAG 2.2.1), and asks for nothing.
 */
export function FormatNoteCard({
  note,
  onSwitch,
  onUndo,
  onExpire,
}: {
  readonly note: FormatNote;
  readonly onSwitch: () => void;
  readonly onUndo: () => void;
  readonly onExpire: () => void;
}) {
  const card = useRef<ViewInstance>(null);
  const [held, setHeld] = useState({ focus: false, pointer: false });
  const hold = held.focus || held.pointer;
  useEffect(() => {
    (card.current as unknown as { focus?: () => void } | null)?.focus?.();
    return returnFocusToReader;
  }, []);
  useEffect(() => {
    if (hold) return undefined;
    const timer = setTimeout(onExpire, NOTE_MS);
    return () => clearTimeout(timer);
  }, [hold, onExpire]);
  const filled = note.kept.at === undefined || note.kept.of === undefined ? undefined : note.kept.at / note.kept.of;
  return (
    <View
      ref={card}
      tabIndex={-1}
      style={styles.card}
      role="status"
      accessibilityLiveRegion="polite"
      testID="format-note"
      onFocus={() => setHeld((now) => ({ ...now, focus: true }))}
      onBlur={() => setHeld((now) => ({ ...now, focus: false }))}
      onPointerEnter={() => setHeld((now) => ({ ...now, pointer: true }))}
      onPointerLeave={() => setHeld((now) => ({ ...now, pointer: false }))}
      onKeyDown={(event: { nativeEvent?: { key?: string }; key?: string }) => {
        const key = event.nativeEvent?.key ?? event.key;
        if (key === 'Escape') onUndo();
        else if ((key === 'f' || key === 'F') && note.canSwitchToReel) onSwitch();
      }}
    >
      <Text variant="monoXs" color={content.ink2}>
        {note.kicker}
      </Text>
      <Text variant="title">{note.title}</Text>
      {note.facts === '' ? null : (
        <Text variant="meta" color={content.ink2}>
          {note.facts}
        </Text>
      )}
      {filled === undefined ? null : (
        <View style={styles.bar} aria-hidden>
          <View style={[styles.fill, { width: `${String(Math.round(filled * 100))}%` }]} />
        </View>
      )}
      <View style={styles.actions}>
        {note.canSwitchToReel ? (
          <View style={styles.action}>
            <Button label="Switch to Reel" size="sm" onPress={onSwitch} testID="format-note-switch" />
            <KeyChip name="F" />
          </View>
        ) : null}
        <View style={styles.action}>
          <Button label="Undo" size="sm" onPress={onUndo} testID="format-note-undo" />
          <KeyChip name="Esc" />
        </View>
      </View>
      <Text variant="meta" color={content.ink2} testID="format-note-kept">
        {keptWords(note.kept)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    boxShadow: elevation.raised,
  },
  bar: {
    height: 8,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
    overflow: 'hidden',
  },
  fill: { height: '100%', backgroundColor: content.continue },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] },
  action: { flexDirection: 'row', alignItems: 'center', gap: spacing[1] },
  key: {
    minWidth: 28,
    minHeight: 24,
    paddingHorizontal: spacing[1],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.tag,
    borderWidth: borderWidth.hairline,
    borderColor: content.ink,
  },
});
