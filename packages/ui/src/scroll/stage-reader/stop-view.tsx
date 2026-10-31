import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import type { Aside, ReadStop } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import type { QuickAnswer } from './quick-answer';

/** What an aside is called to the reader: the limits aside is "Small print". */
export function asideLabel(kind: Aside['kind']): string {
  return kind === 'limits' ? 'Small print' : kind === 'tangent' ? 'Tangent' : 'Definition';
}

/** What a person can do from a Quick answer; each is also a way out for a person who does not use the selection menu. */
export interface QuickAnswerActions {
  readonly onClose: () => void;
  /** Opens Ask from here with the selected words as the first draft of the question; absent where there is no Ask. */
  readonly onMakeScroll?: ((passage: string) => void) | undefined;
  /** Opens Ask from here with nothing typed; absent where there is no Ask. */
  readonly onFollowUp?: (() => void) | undefined;
  /** Reports the Scroll the answer came from; absent where reports are not offered. */
  readonly onReport?: (() => void) | undefined;
}

/**
 * One read stop: its heading, its lines and paragraphs, the same idea in simpler words on request (applied in place, with
 * Undo, V3 D2) and a Quick answer under it when words were selected and asked about. Both are the Scroll's own authored
 * text and read no model and no network (D-244).
 */
export function ReadStopView({
  stop,
  simpler,
  onToggleSimpler,
  quick,
  quickActions,
  onQuickLayout,
}: {
  readonly stop: ReadStop;
  readonly simpler: boolean;
  readonly onToggleSimpler: () => void;
  readonly quick?: QuickAnswer | undefined;
  readonly quickActions?: QuickAnswerActions | undefined;
  /** The height the Quick answer took when it was laid out, so the reader can bring it on screen. */
  readonly onQuickLayout?: ((height: number) => void) | undefined;
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
      {quick === undefined || quickActions === undefined ? null : (
        <QuickAnswerCard quick={quick} actions={quickActions} onLayout={onQuickLayout} />
      )}
    </View>
  );
}

/**
 * A Quick answer (V3 D2): the passage the reader asked about, the Scroll's own plainer words for it and what the Scroll
 * says beside it. It says what it is: made from this Scroll's own words, not a new Scroll. "Make it a full Scroll" hands the
 * question to Ask from here, which is where a new, checked Scroll is made. It never counts as reading anything else and
 * is not remembered, so it never reaches the Universe.
 */
function QuickAnswerCard({
  quick,
  actions,
  onLayout,
}: {
  readonly quick: QuickAnswer;
  readonly actions: QuickAnswerActions;
  readonly onLayout?: ((height: number) => void) | undefined;
}) {
  return (
    <View
      role="region"
      aria-label="Quick answer"
      style={styles.quick}
      testID="quick-answer"
      onLayout={(event) => onLayout?.(event.nativeEvent.layout.height)}
    >
      <View style={styles.quickTop}>
        <Text variant="monoXs" color={content.accentDeep} style={styles.quickLabel}>
          QUICK ANSWER · FROM THIS SCROLL
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the quick answer"
          onPress={actions.onClose}
          style={styles.quickClose}
          testID="quick-answer-close"
        >
          <Icon name="close" size={16} color={content.ink} />
        </Pressable>
      </View>
      <Text variant="ui" heading={3}>{`About “${quick.passage}”`}</Text>
      <Text variant="bodyS">{quick.body}</Text>
      {quick.beside.map((aside) => (
        <View key={aside.id} style={styles.quickBeside}>
          <Text variant="label" color={content.ink2}>
            {aside.title}
          </Text>
          <Text variant="bodyS">{aside.text}</Text>
        </View>
      ))}
      <Text variant="metaS" color={content.ink2}>
        This is the Scroll's own wording for the passage. A new Scroll, made for your question, is checked.
      </Text>
      <View style={styles.quickActions}>
        {actions.onMakeScroll === undefined ? null : (
          <Button
            label="Make it a full Scroll"
            variant="primary"
            size="sm"
            onPress={() => actions.onMakeScroll?.(quick.passage)}
            testID="quick-answer-make"
          />
        )}
        {actions.onFollowUp === undefined ? null : (
          <Button label="Ask a follow-up" size="sm" onPress={actions.onFollowUp} testID="quick-answer-follow-up" />
        )}
        {actions.onReport === undefined ? null : (
          <Button label="Report" variant="ghost" size="sm" onPress={actions.onReport} testID="quick-answer-report" />
        )}
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
  quick: {
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
  quickTop: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  quickLabel: { flex: 1 },
  quickClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  quickBeside: { gap: 2, paddingTop: spacing[1] },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
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
