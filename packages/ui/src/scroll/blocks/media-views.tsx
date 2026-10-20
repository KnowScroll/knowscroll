import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { useDisplay } from '../../display/display';
import { PendingStripe } from '../../feedback/pending-stripe';
import { Text } from '../../text/text';
import { useScrollRender } from '../context';
import type { ScrollMediaRequest } from '../media';

const KIND_LABELS = { still: 'Image', loop: 'Silent loop', video: 'Video', audio: 'Audio' } as const;

function clock(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * What stands where admitted media has not arrived (the media pipeline is S2.4): a striped panel
 * that says what it is and carries the alt text in plain sight, so a figure is never a blank and
 * the words a figure adds are always there. Not a control: nothing here plays.
 */
export function MediaPlaceholder({
  request,
  testID,
}: {
  readonly request: ScrollMediaRequest;
  readonly testID?: string;
}) {
  const detail = request.durationMs === undefined ? null : ` · ${clock(request.durationMs)}`;
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={request.alt}
      style={styles.placeholder}
    >
      <PendingStripe />
      <View style={styles.inner}>
        <Text variant="label" color={content.ink2}>
          {`${KIND_LABELS[request.kind]}${detail ?? ''} · not loaded`}
        </Text>
        <Text variant="bodyS">{request.alt}</Text>
      </View>
    </View>
  );
}

/** The app's media if it has it, otherwise the placeholder. */
function Media({ request }: { readonly request: ScrollMediaRequest }) {
  const context = useScrollRender();
  const drawn = context.renderMedia?.(request) ?? null;
  return <>{drawn ?? <MediaPlaceholder request={request} />}</>;
}

/** An admitted still or silent loop, with its caption. Under reduced motion a loop is its poster. */
export function FigureView({ block }: { readonly block: BlockOfType<'figure'> }) {
  const { reducedMotion } = useDisplay();
  const { media, motion, alt, caption } = block.data;
  return (
    <View role="figure" accessibilityLabel={block.a11y.label} style={styles.figure}>
      <Media request={{ kind: motion === 'loop' ? 'loop' : 'still', media, alt, reducedMotion }} />
      {caption === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {caption}
        </Text>
      )}
    </View>
  );
}

/**
 * An admitted clip. It never autoplays with sound and never plays here yet: until the media
 * pipeline arrives it is the placeholder and its transcript, which is also its text version and
 * is always shown, so the words of a clip are never missing.
 */
export function MediaView({ block }: { readonly block: BlockOfType<'media'> }) {
  const { reducedMotion } = useDisplay();
  const { kind, media, poster, captions, alt, transcript, durationMs } = block.data;
  return (
    <View role="group" accessibilityLabel={block.a11y.label} style={styles.figure}>
      <Media request={{ kind, media, poster, captions, alt, durationMs, reducedMotion }} />
      <View style={styles.transcript}>
        <Text variant="label" color={content.ink2}>
          Transcript
        </Text>
        <Text variant="bodyS" selectable>
          {transcript}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  figure: { gap: spacing[2] },
  placeholder: {
    minHeight: 150,
    overflow: 'hidden',
    justifyContent: 'flex-end',
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.muted,
    backgroundColor: content.paper2,
  },
  inner: { gap: spacing[1], padding: spacing['3.5'] },
  transcript: {
    gap: spacing[1],
    padding: spacing['3.5'],
    borderRadius: radius.card,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
});
