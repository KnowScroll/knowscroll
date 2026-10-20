import { StyleSheet, View } from 'react-native';
import { borderWidth, breakpoints, content, radius, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { useDisplay } from '../../display/display';
import { Text } from '../../text/text';
import { blockAttributes } from '../data-attributes';
import { RichSpans } from '../rich-text';
import { BlockFrame } from './frame';
import { BlockLabel } from './parts';

/**
 * Two or three ways of seeing something, side by side (E03-2). Two columns share the row on a
 * phone; three stack there, because a third column would be too narrow to read.
 */
export function ComparisonView({ block }: { readonly block: BlockOfType<'comparison'> }) {
  const { width } = useDisplay();
  const { title, columns, caption } = block.data;
  const stacked = columns.length > 2 && width <= breakpoints.phoneMax;
  return (
    <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
      <BlockLabel>{title}</BlockLabel>
      <View style={[styles.columns, stacked ? styles.stacked : null]}>
        {columns.map((column, index) => (
          <View
            key={index}
            role="group"
            accessibilityLabel={column.label}
            style={[styles.column, index % 2 === 0 ? styles.sunken : null, stacked ? styles.full : null]}
          >
            <Text variant="ui" style={styles.label}>
              {column.label}
            </Text>
            {column.points.map((point, pointIndex) => (
              <Text key={pointIndex} variant="bodyS" selectable {...blockAttributes(block.id)}>
                <RichSpans spans={point} blockId={block.id} />
              </Text>
            ))}
          </View>
        ))}
      </View>
      {caption === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {caption}
        </Text>
      )}
    </BlockFrame>
  );
}

/** Ordered events down a rail: when, what, and a little more. The order of the document is the order of time. */
export function TimelineView({ block }: { readonly block: BlockOfType<'timeline'> }) {
  const { title, events } = block.data;
  return (
    <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
      <BlockLabel>{title}</BlockLabel>
      <View role="list">
        {events.map((event, index) => (
          <View key={event.id} role="listitem" style={styles.event}>
            <View style={styles.rail} accessible={false} aria-hidden importantForAccessibility="no-hide-descendants">
              <View
                style={[
                  styles.line,
                  index === 0 ? styles.lineFirst : null,
                  index === events.length - 1 ? styles.lineLast : null,
                ]}
              />
              <View style={styles.dot} />
            </View>
            <View style={styles.eventText}>
              <Text variant="label" color={content.ink2}>
                {event.when}
              </Text>
              <Text variant="ui" style={styles.label}>
                {event.title}
              </Text>
              {event.detail === undefined ? null : (
                <Text variant="bodyS" selectable {...blockAttributes(block.id)}>
                  <RichSpans spans={event.detail} blockId={block.id} />
                </Text>
              )}
            </View>
          </View>
        ))}
      </View>
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  columns: { flexDirection: 'row', gap: spacing['2.5'] },
  stacked: { flexDirection: 'column' },
  column: {
    flex: 1,
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.md,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  full: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', alignSelf: 'stretch' },
  sunken: { backgroundColor: content.paper2 },
  label: { fontWeight: '700' },
  event: { flexDirection: 'row', gap: spacing[3] },
  rail: { width: spacing[4], alignItems: 'center' },
  line: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: content.ink },
  lineFirst: { top: spacing[2] },
  lineLast: { bottom: '60%' },
  dot: {
    marginTop: spacing[1],
    width: spacing['2.5'],
    height: spacing['2.5'],
    borderRadius: radius.pill,
    backgroundColor: content.ink,
  },
  eventText: { flex: 1, gap: spacing[1], paddingBottom: spacing[4] },
});
