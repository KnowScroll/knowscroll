import { Pressable, StyleSheet, View } from 'react-native';
import { borderWidth, content, elevation, radius, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { useFocusRing } from '../../display/focus-ring';
import { Icon } from '../../icons/icon';
import { Text } from '../../text/text';
import { useBlockState, useScrollRender } from '../context';
import { blockAttributes } from '../data-attributes';
import { dropCapOf } from '../drop-cap';
import { RichSpans } from '../rich-text';
import { BlockFrame } from './frame';

/** Prose. The text is exactly the block's passage projection; `blockId` anchors its offsets. */
export function ParagraphView({
  block,
  initialCap = false,
}: {
  readonly block: BlockOfType<'paragraph'>;
  /** An editorial essay's opening paragraph starts with a drop cap. */
  readonly initialCap?: boolean;
}) {
  const cap = dropCapOf(block.data.spans, initialCap);
  return (
    <Text variant="body" selectable {...blockAttributes(block.id)} {...cap.textProps}>
      <RichSpans spans={cap.spans} blockId={block.id} />
    </Text>
  );
}

/** A heading inside a section: a real level-3 heading for rotor and landmark navigation. */
export function SubheadingView({ block }: { readonly block: BlockOfType<'subheading'> }) {
  return (
    <Text variant="title" heading={3} style={styles.subheading}>
      {block.data.text}
    </Text>
  );
}

/** Where each list item starts in the block's passage projection: items are joined by "\n". */
export function itemOffsets(items: readonly (readonly { readonly text: string }[])[]): number[] {
  const starts: number[] = [];
  items.reduce((at, item) => {
    starts.push(at);
    return at + item.reduce((total, span) => total + span.text.length, 0) + 1;
  }, 0);
  return starts;
}

export function ListView({ block }: { readonly block: BlockOfType<'list'> }) {
  const starts = itemOffsets(block.data.items);
  const rows = block.data.items.map((item, index) => ({ item, index, start: starts[index] ?? 0 }));
  return (
    <View role="list" accessibilityLabel={block.a11y.label} style={styles.list}>
      {rows.map(({ item, index, start }) => (
        <View key={index} role="listitem" style={styles.row}>
          <View accessible={false} aria-hidden importantForAccessibility="no-hide-descendants" style={styles.marker}>
            <Text variant="body" color={content.ink2}>
              {block.data.style === 'number' ? `${index + 1}.` : '•'}
            </Text>
          </View>
          <View style={styles.rowText}>
            <Text variant="body" selectable {...blockAttributes(block.id)}>
              <RichSpans spans={item} blockId={block.id} baseOffset={start} />
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function QuoteView({ block }: { readonly block: BlockOfType<'quote'> }) {
  const pull = block.data.kind === 'pull';
  return (
    <View
      role="group"
      accessibilityLabel={block.a11y.label}
      style={[styles.quote, pull ? styles.pullQuote : styles.quotation]}
    >
      <Text variant={pull ? 'heading' : 'body'} selectable {...blockAttributes(block.id)}>
        <RichSpans spans={block.data.spans} blockId={block.id} />
      </Text>
      {block.data.attribution === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {`— ${block.data.attribution}`}
        </Text>
      )}
    </View>
  );
}

const CALLOUT_LABELS = {
  note: 'Note',
  example: 'Example',
  limit: 'Limits',
  'key-idea': 'Key idea',
  'try-it': 'Try it',
} as const;

const calloutLooks = {
  note: { background: content.paper2, border: content.ink, borderStyle: 'solid', label: content.ink2 },
  example: { background: content.paper, border: content.ink, borderStyle: 'solid', label: content.ink2 },
  limit: { background: content.paper2, border: content.muted, borderStyle: 'dashed', label: content.ink2 },
  'key-idea': { background: content.paper, border: content.accent, borderStyle: 'solid', label: content.accentDeep },
  'try-it': { background: content.paper, border: content.accent, borderStyle: 'dashed', label: content.accentDeep },
} as const;

/** An aside: note, example, a limit, the key idea, or an invitation to use the block above. */
export function CalloutView({ block }: { readonly block: BlockOfType<'callout'> }) {
  const look = calloutLooks[block.data.kind];
  return (
    <View
      role="group"
      accessibilityLabel={block.a11y.label}
      style={[
        styles.callout,
        { backgroundColor: look.background, borderColor: look.border, borderStyle: look.borderStyle },
        block.data.kind === 'key-idea' ? { boxShadow: elevation.current } : null,
      ]}
    >
      <View style={styles.calloutLabel}>
        {block.data.kind === 'try-it' ? <Icon name="arrowRight" size={16} color={look.label} /> : null}
        <Text variant="label" color={look.label}>
          {CALLOUT_LABELS[block.data.kind]}
        </Text>
      </View>
      {block.data.title === undefined ? null : (
        <Text variant="bodyS" style={styles.calloutTitle}>
          {block.data.title}
        </Text>
      )}
      <Text variant="body" selectable {...blockAttributes(block.id)}>
        <RichSpans spans={block.data.spans} blockId={block.id} />
      </Text>
    </View>
  );
}

/**
 * A reveal. Its expanded state is the reader's, kept by (revision, block id). Expanding changes
 * the layout at once, with no animation, so reduced motion needs no variant.
 */
export function DisclosureView({ block }: { readonly block: BlockOfType<'disclosure'> }) {
  const context = useScrollRender();
  const handle = useBlockState(block);
  const focus = useFocusRing('onLight');
  const expanded = handle.state?.type === 'disclosure' && handle.state.expanded;
  const toggle = () => {
    handle.setState({ type: 'disclosure', expanded: !expanded });
    context.report(block.id, 'disclosure', expanded ? 'collapsed' : 'expanded');
  };
  return (
    <BlockFrame style={styles.disclosure}>
      <Pressable
        {...focus.props}
        accessibilityRole="button"
        accessibilityLabel={block.data.summary}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={toggle}
        style={[styles.summary, expanded ? styles.summaryOpen : null, focus.style]}
      >
        <View style={styles.summaryText}>
          <Text variant="ui" style={styles.summaryLabel}>
            {block.data.summary}
          </Text>
        </View>
        <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={20} />
      </Pressable>
      {expanded ? (
        <View style={styles.disclosureBody}>{block.data.blocks.map((child) => context.renderNested(child))}</View>
      ) : null}
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  subheading: { marginTop: spacing[2] },
  list: { gap: spacing[2] },
  row: { flexDirection: 'row', gap: spacing[2], alignItems: 'flex-start' },
  marker: { minWidth: spacing[6], alignItems: 'flex-end' },
  rowText: { flex: 1 },
  quote: { gap: spacing[2], paddingLeft: spacing[4], borderLeftWidth: spacing[1] },
  pullQuote: { borderLeftColor: content.accent },
  quotation: { borderLeftColor: content.ink },
  callout: {
    gap: spacing[2],
    padding: spacing['3.5'],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
  },
  calloutLabel: { flexDirection: 'row', alignItems: 'center', gap: spacing['1.5'] },
  calloutTitle: { fontWeight: '700' },
  disclosure: { padding: 0, overflow: 'hidden', gap: 0 },
  summary: {
    minHeight: spacing[14],
    paddingHorizontal: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    backgroundColor: content.paper2,
    cursor: 'pointer' as const,
  },
  summaryOpen: { borderBottomWidth: borderWidth.regular, borderBottomColor: content.ink },
  summaryText: { flex: 1 },
  summaryLabel: { fontWeight: '700' },
  disclosureBody: { padding: spacing[4], gap: spacing[3] },
});
