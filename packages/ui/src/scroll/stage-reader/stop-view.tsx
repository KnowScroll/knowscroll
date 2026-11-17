import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { ReadStop } from '@knowscroll/scroll-model';
import { useFocusRing } from '../../display/focus-ring';
import { Text } from '../../text/text';
import { GuideView, PlayBlockView } from '../play-blocks';

/**
 * One read stop: its heading, its lines and paragraphs, the guide's line and the play block when it has
 * them (D-207), and the same idea in simpler words on request, applied in place with Undo (V3 D2). `textVersion` is the
 * reader's text version, which the guide and the play block follow. Simpler swaps only the stop's own text: the guide's
 * line and the play block stay. The simpler words are the stop's authored text (D-085), so showing them calls no model
 * (D-244).
 */
export function ReadStopView({
  stop,
  textVersion = false,
  simpler,
  onToggleSimpler,
}: {
  readonly stop: ReadStop;
  readonly textVersion?: boolean;
  readonly simpler: boolean;
  readonly onToggleSimpler: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.stop}>
      {simpler ? (
        <View style={styles.simpler} testID="simpler-text">
          <Text variant="body">{stop.simple}</Text>
        </View>
      ) : (
        stop.blocks.map((block, index) =>
          block.type === 'heading' ? (
            <Text key={index} variant="heading" heading={2}>
              {block.text}
            </Text>
          ) : block.type === 'line' ? (
            <Text key={index} variant="title">
              {block.text}
            </Text>
          ) : (
            <Text key={index} variant="body">
              {block.text}
            </Text>
          ),
        )
      )}
      {stop.guide === undefined ? null : <GuideView guide={stop.guide} asText={textVersion} />}
      {stop.interactive === undefined ? null : (
        <PlayBlockView interactive={stop.interactive} readerAsText={textVersion} />
      )}
      <View style={styles.simplerRow}>
        {simpler ? (
          <View style={styles.simplerChip}>
            <Text variant="monoXs" color={content.ink}>
              SIMPLER VERSION
            </Text>
          </View>
        ) : null}
        <Pressable
          {...focus.props}
          accessibilityRole="button"
          accessibilityLabel={simpler ? 'Undo simpler version' : 'Say it simpler'}
          onPress={onToggleSimpler}
          style={[styles.simplerButton, focus.style]}
          testID="simpler-toggle"
        >
          <Text variant="uiS" color={content.accentDeep}>
            {simpler ? 'Undo' : 'Say it simpler'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stop: { gap: spacing[3] },
  simpler: {
    padding: spacing[3],
    borderRadius: radius.card,
    backgroundColor: content.highlight,
  },
  simplerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], flexWrap: 'wrap' },
  simplerChip: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
  },
  simplerButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
});
