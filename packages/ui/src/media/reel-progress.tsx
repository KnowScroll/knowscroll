import { StyleSheet, View } from 'react-native';
import { content, overlay, spacing } from '@knowscroll/design-tokens';
import { IconButton } from '../actions/icon-button';
import { Text } from '../text/text';

/** `0:31` for 31 s. Whole seconds, never rounded up past the end. */
export function formatClock(milliseconds: number): string {
  const total = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

export interface ReelProgressProps {
  readonly positionMs: number;
  readonly durationMs: number;
  readonly muted: boolean;
  /** Explicit sound choice. Omit to draw the bar and time only. */
  readonly onToggleMuted?: () => void;
}

/**
 * The Reel's progress row (E01): a thin track, "0:31 / 0:50", and the sound switch. The bar
 * is a read-out, not a scrubber; it never shows percentages or "watched" wording.
 */
export function ReelProgress({ positionMs, durationMs, muted, onToggleMuted }: ReelProgressProps) {
  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  return (
    <View style={styles.row} pointerEvents="box-none">
      <View
        role="progressbar"
        accessibilityLabel="Reel progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(positionMs / 1000)}
        aria-valuetext={`${formatClock(positionMs)} of ${formatClock(durationMs)}`}
        style={styles.track}
        pointerEvents="none"
      >
        <View style={[styles.fill, { width: `${String(Math.round(fraction * 1000) / 10)}%` }]} />
      </View>
      <Text variant="label" color={content.paper} style={[styles.time, { pointerEvents: 'none' }]}>
        {formatClock(positionMs)} / {formatClock(durationMs)}
      </Text>
      {onToggleMuted === undefined ? null : (
        <IconButton
          icon={muted ? 'volumeOff' : 'volume'}
          label={muted ? 'Unmute' : 'Mute'}
          variant="onMedia"
          size={44}
          pressed={muted}
          onPress={onToggleMuted}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing['2.5'] },
  track: { flex: 1, height: 4, borderRadius: 4, backgroundColor: overlay.onMediaTrack, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 4, backgroundColor: content.paper },
  time: { fontVariant: ['tabular-nums'] },
});
