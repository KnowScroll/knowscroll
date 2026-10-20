import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import type { ReadingObserver } from '@knowscroll/client-core';
import { borderWidth, content, layout, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';
import type { ScrollDocument, Span } from '@knowscroll/scroll-model';

/**
 * TEMPORARY, MARKED FOR REPLACEMENT. A minimal text view of a `scroll-document.v1`, so the thin
 * journey (#229) can render, report what is read and restore a position before the Scroll renderers
 * of #230 part 2 (`ScrollArticle` in `packages/ui/src/scroll`) are on the integration branch. It
 * draws only the text-family blocks (paragraph, subheading, list, quote, callout, disclosure) and the
 * server's readable fallback; it has no templates, themes, block state or corrections UI.
 *
 * Delete this file, `capabilities.ts` and the `TemporaryArticle` import of `scroll-screen.tsx` when
 * `ScrollArticle` lands: it takes the same `document`, `observer`, `paused` and `anchorBlockId`, and
 * reports the same three observer events.
 *
 * What it does for the recorder (the observer contract, blueprint §18): block visibility as a fraction
 * of the block's area inside the reading viewport (a block taller than the viewport reaches 1 when it
 * fills it), reported on mount and when it changes by at least a tenth or crosses 0, 0.5 or 1;
 * deliberate disclosure interactions; and activity (app backgrounded or tab hidden, or `paused`).
 */
export interface TemporaryArticleProps {
  readonly document: ScrollDocument;
  readonly observer: ReadingObserver;
  /** An overlay holds the reader: the article reports itself inactive. */
  readonly paused?: boolean;
  /** The block to restore to: the view scrolls to it once it is laid out. */
  readonly anchorBlockId?: string;
  /** Room for the screen's chrome around the article. */
  readonly contentInset: { readonly top: number; readonly bottom: number };
  /** Rendered between the opening and the first section. */
  readonly afterHeader?: ReactNode;
}

type Block = ScrollDocument['sections'][number]['blocks'][number];
type NestedBlock = Extract<Block, { type: 'disclosure' }>['data']['blocks'][number];

const now = (): number => performance.now();

/** A fraction crossed 0, 0.5 or 1, or moved by at least a tenth since it was last reported. */
function worthReporting(previous: number | undefined, next: number): boolean {
  if (previous === undefined) return true;
  if (Math.abs(next - previous) >= 0.1) return true;
  return [0, 0.5, 1].some((line) => previous < line !== next < line || previous <= line !== next <= line);
}

function Spans({ spans, selectable = true }: { readonly spans: readonly Span[]; readonly selectable?: boolean }) {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={index}
          variant="body"
          selectable={selectable}
          style={[
            span.marks?.includes('em') === true ? styles.em : null,
            span.marks?.includes('strong') === true ? styles.strong : null,
            span.marks?.includes('code') === true ? styles.code : null,
          ]}
        >
          {span.text}
        </Text>
      ))}
    </>
  );
}

function Disclosure({
  block,
  onToggle,
}: {
  readonly block: Extract<Block, { type: 'disclosure' }>;
  readonly onToggle: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.disclosure}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={block.a11y.label}
        accessibilityState={{ expanded }}
        style={styles.summary}
        onPress={() => {
          setExpanded((value) => !value);
          onToggle();
        }}
      >
        <Text variant="ui">
          {expanded ? '− ' : '+ '}
          {block.data.summary}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.disclosureBody}>
          {block.data.blocks.map((child) => (
            <BlockView key={child.id} block={child} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function BlockView({ block }: { readonly block: Block | NestedBlock }) {
  switch (block.type) {
    case 'paragraph':
      return (
        <Text variant="body" selectable>
          <Spans spans={block.data.spans} />
        </Text>
      );
    case 'subheading':
      return (
        <Text variant="title" heading={3}>
          {block.data.text}
        </Text>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.data.items.map((item, index) => (
            <View key={index} style={styles.listItem}>
              <Text variant="body" style={styles.marker}>
                {block.data.style === 'number' ? `${String(index + 1)}.` : '•'}
              </Text>
              <Text variant="body" selectable style={styles.itemText}>
                <Spans spans={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={styles.quote}>
          <Text variant="title" selectable>
            <Spans spans={block.data.spans} />
          </Text>
          {block.data.attribution === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {block.data.attribution}
            </Text>
          )}
        </View>
      );
    case 'callout':
      return (
        <View style={styles.callout}>
          {block.data.title === undefined ? null : (
            <Text variant="label" color={content.ink2}>
              {block.data.title}
            </Text>
          )}
          <Text variant="body" selectable>
            <Spans spans={block.data.spans} />
          </Text>
        </View>
      );
    case 'fallback':
      // The server's readable stand-in for a block this build cannot draw: never a blank area.
      return (
        <View style={styles.fallback}>
          <Text variant="body" selectable>
            {block.fallbackText}
          </Text>
        </View>
      );
    case 'chart':
    case 'code':
    case 'comparison':
    case 'diagram':
    case 'disclosure':
    case 'figure':
    case 'media':
    case 'sequence':
    case 'simulation':
    case 'table':
    case 'timeline':
      return (
        <View style={styles.fallback}>
          <Text variant="body" selectable>
            {block.fallbackText}
          </Text>
        </View>
      );
  }
}

/** One top-level block, with its layout reported for the visibility measure. */
function PlacedBlock({
  block,
  onPlaced,
  onInteraction,
}: {
  readonly block: Block;
  readonly onPlaced: (blockId: string, y: number, height: number) => void;
  readonly onInteraction: (blockId: string) => void;
}) {
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => onPlaced(block.id, event.nativeEvent.layout.y, event.nativeEvent.layout.height),
    [block.id, onPlaced],
  );
  return (
    <View onLayout={onLayout} style={styles.item} testID={`scroll-block-${block.id}`}>
      {block.type === 'disclosure' ? (
        <Disclosure block={block} onToggle={() => onInteraction(block.id)} />
      ) : (
        <BlockView block={block} />
      )}
    </View>
  );
}

export function TemporaryArticle({
  document,
  observer,
  paused = false,
  anchorBlockId,
  contentInset,
  afterHeader,
}: TemporaryArticleProps) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const observerRef = useRef(observer);
  useEffect(() => {
    observerRef.current = observer;
  });
  const placed = useRef(new Map<string, { y: number; height: number }>());
  const reported = useRef(new Map<string, number>());
  const viewport = useRef({ height: 0, scrollY: 0 });
  const restored = useRef(false);

  const evaluate = useCallback(() => {
    const { height, scrollY } = viewport.current;
    if (height <= 0) return;
    for (const [blockId, box] of placed.current) {
      if (box.height <= 0) continue;
      const visible = Math.max(0, Math.min(box.y + box.height, scrollY + height) - Math.max(box.y, scrollY));
      // A block taller than the viewport counts as fully visible when it fills it.
      const fraction = Math.min(1, visible / Math.min(box.height, height));
      if (worthReporting(reported.current.get(blockId), fraction)) {
        reported.current.set(blockId, fraction);
        observerRef.current.onBlockVisibility({ blockId, visibleFraction: fraction, at: now() });
      }
    }
  }, []);

  const onPlaced = useCallback(
    (blockId: string, y: number, height: number) => {
      placed.current.set(blockId, { y, height });
      if (!restored.current && anchorBlockId === blockId) {
        restored.current = true;
        // Layout above the anchor may still move it: place it now and again once things settle.
        const place = () =>
          scrollRef.current?.scrollTo({
            y: Math.max(0, (placed.current.get(blockId)?.y ?? y) - spacing[4]),
            animated: false,
          });
        place();
        setTimeout(place, 300);
        setTimeout(place, 900);
      }
      evaluate();
    },
    [anchorBlockId, evaluate],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      viewport.current.scrollY = event.nativeEvent.contentOffset.y;
      evaluate();
    },
    [evaluate],
  );

  const onViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewport.current.height = event.nativeEvent.layout.height;
      evaluate();
    },
    [evaluate],
  );

  // Activity: the app or tab in front (react-native-web maps AppState to page visibility), and `paused`.
  const appActive = useRef(AppState.currentState === 'active');
  const lastActive = useRef<boolean | undefined>(undefined);
  const publishActivity = useCallback((active: boolean) => {
    if (lastActive.current === active) return;
    lastActive.current = active;
    observerRef.current.onActivity({ active, at: now() });
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      appActive.current = next === 'active';
      publishActivity(appActive.current && !paused);
    });
    return () => subscription.remove();
  }, [paused, publishActivity]);
  useEffect(() => {
    publishActivity(appActive.current && !paused);
  }, [paused, publishActivity]);

  // Everything that mounted counts as unmounted when the article goes: close its intervals.
  useEffect(() => {
    const seen = reported.current;
    return () => {
      for (const blockId of seen.keys()) {
        observerRef.current.onBlockVisibility({ blockId, visibleFraction: 0, at: now() });
      }
    };
  }, []);

  const onInteraction = useCallback(
    (blockId: string) => observerRef.current.onBlockInteraction({ blockId, kind: 'disclosure', at: now() }),
    [],
  );

  const sections = useMemo(() => document.sections, [document.sections]);
  return (
    <ScrollView
      ref={scrollRef}
      testID="scroll-article"
      onLayout={onViewportLayout}
      onScroll={onScroll}
      scrollEventThrottle={32}
      style={styles.scroll}
      contentContainerStyle={[styles.content, { paddingTop: contentInset.top, paddingBottom: contentInset.bottom }]}
    >
      <View style={styles.header}>
        <Text variant="label" color={content.ink2}>
          {document.kicker}
        </Text>
        <Text variant="displayL" heading={1}>
          {document.title}
        </Text>
        <Text variant="body" color={content.ink2}>
          {document.dek}
        </Text>
        <Text variant="label" color={content.ink2}>
          {`A Scroll · ${String(document.measures.readingMinutes)} min`}
        </Text>
      </View>
      {afterHeader}
      {sections.flatMap((section) => [
        section.heading === null ? null : (
          <View key={`heading-${section.id}`} style={styles.item}>
            <Text variant="heading" heading={2} style={styles.sectionHeading}>
              {section.heading}
            </Text>
          </View>
        ),
        ...section.blocks.map((block) => (
          <PlacedBlock key={block.id} block={block} onPlaced={onPlaced} onInteraction={onInteraction} />
        )),
      ])}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: content.paper },
  content: {
    paddingHorizontal: layout.gutter,
    gap: spacing['3.5'],
    maxWidth: layout.measureDesktop,
    width: '100%',
    alignSelf: 'center',
  },
  header: { gap: spacing[3], paddingBottom: spacing[2] },
  item: { width: '100%' },
  sectionHeading: { marginTop: spacing[4] },
  em: { fontStyle: 'italic' },
  strong: { fontWeight: '700' },
  code: { backgroundColor: content.paper2 },
  list: { gap: spacing[2] },
  listItem: { flexDirection: 'row', gap: spacing[2] },
  marker: { width: spacing[6] },
  itemText: { flex: 1 },
  quote: { borderLeftWidth: spacing[1], borderLeftColor: content.accent, paddingLeft: spacing[4], gap: spacing[2] },
  callout: {
    gap: spacing[2],
    padding: spacing[4],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  fallback: {
    padding: spacing[4],
    borderRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.muted,
    borderStyle: 'dashed',
  },
  disclosure: { gap: spacing[2] },
  summary: { paddingVertical: spacing[3] },
  disclosureBody: { gap: spacing[3] },
});
