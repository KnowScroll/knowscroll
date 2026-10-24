import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { formatRange, initialRange, nudgeRange, setRangeEnd, type ReelRange } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Button, Text, useTypeStyle } from '@knowscroll/ui';

const NOTE = 'Look at this moment:';

/** A bar showing where in the Reel the chosen moment lies. */
function Timeline({ range, durationMs }: { readonly range: ReelRange; readonly durationMs: number }) {
  const left = (range.startMs / durationMs) * 100;
  const width = ((range.endMs - range.startMs) / durationMs) * 100;
  return (
    <View style={styles.timeline} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={[styles.selection, { left: `${String(left)}%`, width: `${String(width)}%` }]} />
    </View>
  );
}

function EndControl({
  label,
  ms,
  onNudge,
  onHere,
}: {
  readonly label: 'Start' | 'End';
  readonly ms: number;
  readonly onNudge: (deltaMs: number) => void;
  readonly onHere: () => void;
}) {
  const seconds = Math.floor(ms / 1000);
  const clock = `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <View role="group" accessibilityLabel={`${label} ${clock}`} style={styles.end}>
      <Text variant="ui" style={styles.endLabel}>
        {label} {clock}
      </Text>
      <View style={styles.buttons}>
        <Button label="−5 s" size="sm" variant="ghost" onPress={() => onNudge(-5000)} />
        <Button label="−1 s" size="sm" variant="ghost" onPress={() => onNudge(-1000)} />
        <Button label="+1 s" size="sm" variant="ghost" onPress={() => onNudge(1000)} />
        <Button label="+5 s" size="sm" variant="ghost" onPress={() => onNudge(5000)} />
        <Button
          label="Here"
          size="sm"
          onPress={onHere}
          accessibilityHint={`Sets the ${label.toLowerCase()} to where the player is now`}
        />
      </View>
    </View>
  );
}

/**
 * H03 "Reel · pick a moment": the range starts where the player is and can be moved a second or five at
 * a time, or set to where the player is now. The moment points into the original Reel; no video is made.
 * Sharing writes into this thread only and says nothing about what anyone else has watched.
 */
export function ShareMomentSheet({
  visible,
  title,
  durationMs,
  positionMs,
  currentPositionMs,
  threadName,
  onShare,
  onClose,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly durationMs: number;
  /** Where the player was when the sheet opened: the moment starts here. */
  readonly positionMs: number;
  /** Where the player is now, read when "Here" is pressed. */
  readonly currentPositionMs: () => number;
  readonly threadName: string;
  readonly onShare: (range: ReelRange, note: string) => void;
  readonly onClose: () => void;
}) {
  const [range, setRange] = useState(() => initialRange(positionMs, durationMs));
  const [note, setNote] = useState(NOTE);
  const type = useTypeStyle('bodyS');
  return (
    <BottomSheet visible={visible} title="Share a moment" onClose={onClose}>
      <View style={styles.body}>
        <Text variant="meta" color={content.ink2} numberOfLines={1}>
          {title}
        </Text>
        <Text variant="label" accessibilityLabel={`Moment ${formatRange(range.startMs, range.endMs)}`}>
          {formatRange(range.startMs, range.endMs)}
        </Text>
        <Timeline range={range} durationMs={durationMs} />
        <EndControl
          label="Start"
          ms={range.startMs}
          onNudge={(delta) => setRange(nudgeRange(range, 'start', delta, durationMs))}
          onHere={() => setRange(setRangeEnd(range, 'start', currentPositionMs(), durationMs))}
        />
        <EndControl
          label="End"
          ms={range.endMs}
          onNudge={(delta) => setRange(nudgeRange(range, 'end', delta, durationMs))}
          onHere={() => setRange(setRangeEnd(range, 'end', currentPositionMs(), durationMs))}
        />
        <View style={styles.field}>
          <Text variant="uiS">Message</Text>
          <TextInput
            accessibilityLabel="Message"
            value={note}
            onChangeText={setNote}
            maxLength={500}
            allowFontScaling={false}
            style={[
              styles.input,
              { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight },
            ]}
          />
        </View>
        <View style={styles.footer}>
          <Text variant="monoXs" color={content.ink2} numberOfLines={1} style={styles.to}>
            To · {threadName}
          </Text>
          <Button label="Share" variant="primary" onPress={() => onShare(range, note.trim())} testID="share-moment" />
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing[3] },
  timeline: {
    height: 14,
    borderRadius: radius.tag,
    backgroundColor: content.paper2,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    overflow: 'hidden',
  },
  selection: { position: 'absolute', top: 0, bottom: 0, backgroundColor: content.continue },
  end: { gap: spacing[2] },
  endLabel: { minWidth: 96 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  field: { gap: spacing[1] },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing[3] },
  to: { flex: 1 },
});
