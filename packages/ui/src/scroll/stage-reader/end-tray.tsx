import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { Icon } from '../../icons/icon';
import { Tag } from '../../status/tag';
import { Text } from '../../text/text';

/** A way on as the end tray and the dock offer it: only an admitted continuation is ever shown. */
export interface NextPartPeek {
  /** "Part 2", or "Related" for another angle. */
  readonly label: string;
  readonly title: string;
  readonly onPress: () => void;
}

/**
 * The end of a v2 Scroll (D-134), a simple one: the recap's captions under the stage still showing
 * its last picture, a peek at the next Part, and three honest ways out: continue the thread, stop for
 * today (no streak, no guilt), or something new. The full payoff (sparks, the landmark, the Universe
 * reveal) is a later slice. Nothing here moves on by itself.
 */
export function EndTray({
  recap,
  hasStage,
  nextPart,
  related,
  onSmallPrint,
  onDone,
  onNextTopic,
}: {
  readonly recap: ScrollDocumentV2['recap'];
  /** The Scroll has a stage: only then did the reader "build a picture". */
  readonly hasStage: boolean;
  readonly nextPart?: NextPartPeek | undefined;
  /** Another angle; drawn dashed, as the thread's related tab is. */
  readonly related?: NextPartPeek | undefined;
  /** Opens the limits aside; present when the recap links to one. */
  readonly onSmallPrint?: (() => void) | undefined;
  readonly onDone?: (() => void) | undefined;
  readonly onNextTopic?: (() => void) | undefined;
}) {
  return (
    <View style={styles.tray} testID="end-tray">
      <Text variant="label" color={content.ink2} heading={2}>
        {hasStage ? 'The picture you built' : 'The short version'}
      </Text>
      <View style={styles.captions}>
        {recap.captions.map((caption, index) => (
          <View key={caption} style={styles.caption}>
            <View style={styles.badge} aria-hidden>
              <Text variant="metaS">{String(index + 1)}</Text>
            </View>
            <Text variant="body" style={styles.captionText}>
              {caption}
            </Text>
          </View>
        ))}
      </View>
      {nextPart === undefined ? null : (
        <View style={styles.peek}>
          <Tag label={nextPart.label} variant="part" />
          <Text variant="title">{nextPart.title}</Text>
          <Button
            label={`Continue ${nextPart.label}`}
            icon="arrowRight"
            iconPosition="trailing"
            variant="primary"
            onPress={nextPart.onPress}
          />
        </View>
      )}
      {related === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Another related explanation: ${related.title}`}
          onPress={related.onPress}
          style={styles.relatedRow}
        >
          <Tag label={related.label} variant="neutral" />
          <Text variant="ui" style={styles.relatedTitle} numberOfLines={2}>
            {related.title}
          </Text>
          <Icon name="arrowRight" size={20} color={content.ink} />
        </Pressable>
      )}
      <View style={styles.actions}>
        {onDone === undefined ? null : <Button label="Done for today" onPress={onDone} />}
        {onNextTopic === undefined ? null : <Button label="Something new" icon="arrowUp" onPress={onNextTopic} />}
        {onSmallPrint === undefined ? null : (
          <Button label="Small print" variant="ghost" size="sm" onPress={onSmallPrint} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { gap: spacing[4] },
  captions: { gap: spacing[3] },
  caption: { flexDirection: 'row', gap: spacing[3], alignItems: 'flex-start' },
  captionText: { flex: 1 },
  badge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  peek: {
    gap: spacing[2],
    alignItems: 'flex-start',
    padding: spacing[4],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.continue,
  },
  relatedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 48,
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper,
    cursor: 'pointer' as const,
  },
  relatedTitle: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
