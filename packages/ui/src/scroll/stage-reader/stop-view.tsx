import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { Aside, ReadStop } from '@knowscroll/scroll-model';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';

/** What an aside is called to the reader: the limits aside is "Small print". */
export function asideLabel(kind: Aside['kind']): string {
  return kind === 'limits' ? 'Small print' : kind === 'tangent' ? 'Tangent' : 'Definition';
}

/**
 * One read stop: its heading, its lines and paragraphs, and the same idea in simpler words on request, applied in place
 * with Undo (V3 D2). The simpler words are the stop's own authored text (D-085), so showing them calls no model (D-244).
 */
export function ReadStopView({
  stop,
  simpler,
  onToggleSimpler,
}: {
  readonly stop: ReadStop;
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

/**
 * A side box next to the stop it belongs to, collapsed unless the document opens it. Reading on never
 * needs it; "Small print" is where the limits of the idea live.
 */
export function AsideView({
  aside,
  expanded,
  onToggle,
}: {
  readonly aside: Aside;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const focus = useFocusRing('onLight');
  return (
    <View style={styles.aside} testID={`aside-${aside.id}`}>
      <Pressable
        {...focus.props}
        accessibilityRole="button"
        accessibilityLabel={`${asideLabel(aside.kind)}: ${aside.title}`}
        aria-expanded={expanded}
        onPress={onToggle}
        style={[styles.asideHeader, focus.style]}
      >
        <View style={styles.asideTitle}>
          <Text variant="label" color={content.ink2}>
            {asideLabel(aside.kind)}
          </Text>
          <Text variant="ui">{aside.title}</Text>
        </View>
        <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={18} />
      </Pressable>
      {expanded ? <Text variant="bodyS">{aside.text}</Text> : null}
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
  aside: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  asideHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing[2], minHeight: 44 },
  asideTitle: { flex: 1, gap: 2 },
});
