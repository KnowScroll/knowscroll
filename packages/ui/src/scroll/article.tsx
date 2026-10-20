import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { walkBlocks, type ScrollDocument } from './model';
import { useDisplay } from '../display/display';
import { Text } from '../text/text';
import { resolveAnchor, type AnchorTarget } from './anchors';
import { BlockHost } from './blocks/host';
import { renderNestedBlock } from './blocks/host';
import { ScrollRenderProvider, type ScrollRenderContext } from './context';
import { GestureRoot } from './gestures/gesture-root';
import type { ScrollMediaRenderer } from './media';
import type { ScrollDiagnostics, ScrollReadingObserver } from './observer';
import { useReadingViewport } from './reading/reading-viewport';
import { useArticleActivity } from './reading/use-activity';
import { monotonicNow } from './reading/visibility';
import { createMemoryBlockStateStore, type ScrollBlockStateStore } from './state';
import { EndMark } from './templates/end-mark';
import { TextVersionToggle } from './templates/text-version-toggle';
import { EditorialHeader, PosterHeader } from './templates/headers';
import { CorrectionNotices, FramingNotice } from './templates/notices';

export interface ScrollArticleProps {
  /** A consumer `scroll-document.v1` that went through `prepareScrollDocument` (the client parse). */
  readonly document: ScrollDocument;
  /** Receives what the reader sees and does, as the recorder's three events. Optional. */
  readonly observer?: ScrollReadingObserver;
  /** Receives an internal diagnostic when a block shows its readable stand-in. Optional. */
  readonly diagnostics?: ScrollDiagnostics;
  /** Where block state lives (default: in memory for this article). */
  readonly store?: ScrollBlockStateStore;
  /** Blocks whose state from the previous revision stays valid on this one (from the package's anchor map). */
  readonly carryOverBlockIds?: ReadonlySet<string>;
  /** The block to restore to (`#block`): the article scrolls to it and flashes it. */
  readonly anchorBlockId?: string;
  /** An overlay holds the reader (a sheet is open): the article reports itself inactive. */
  readonly paused?: boolean;
  /** Room for the screen's own chrome around the article. */
  readonly contentInset?: { readonly top: number; readonly bottom: number };
  /** Space the chrome covers inside the scroll area, so those pixels do not count as read. */
  readonly readingInset?: { readonly top: number; readonly bottom: number };
  /** Draws admitted media (S2.4); without it, or when it returns null, figures and clips are placeholders with their alt text. */
  readonly renderMedia?: ScrollMediaRenderer;
  /** Start with the text versions of the visual blocks on ("Text version of diagrams"). */
  readonly initialTextVersion?: boolean;
  /** The encounter actions strip, between the opening and the first section (E02-1). */
  readonly afterHeader?: ReactNode;
  /** App chrome after the end mark: Continue, Next subject and the actions (E02-3). */
  readonly endSlot?: ReactNode;
  readonly testID?: string;
}

/** The anchored block flashes on the highlight ground for this long. */
const FLASH_MS = 1600;
/** After mounting, a later layout above the anchored block still moves the scroll for this long. */
const SETTLE_MS = 1500;
/** Breathing room above the anchored block. */
const ANCHOR_MARGIN = spacing[4];

const NO_INSET = { top: 0, bottom: 0 } as const;
const DEFAULT_INSET = { top: spacing[5], bottom: spacing[18] } as const;

function useAnchorRestore(target: AnchorTarget | null, scrollRef: RefObject<ScrollViewInstance | null>) {
  const appliedAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onPlaced = useCallback(
    (blockId: string, top: number) => {
      if (target === null || blockId !== target.scrollToBlockId) return;
      const now = monotonicNow();
      if (appliedAt.current === null) {
        appliedAt.current = now;
        setFlash(blockId);
        timer.current = setTimeout(() => setFlash(null), FLASH_MS);
      } else if (now - appliedAt.current > SETTLE_MS) {
        return;
      }
      scrollRef.current?.scrollTo({ y: Math.max(0, top - ANCHOR_MARGIN), animated: false });
    },
    [target, scrollRef],
  );
  return { flash, onPlaced };
}

function ScrollArticleBody({
  document,
  observer,
  diagnostics,
  store: givenStore,
  carryOverBlockIds,
  anchorBlockId,
  paused = false,
  contentInset = DEFAULT_INSET,
  readingInset = NO_INSET,
  renderMedia,
  initialTextVersion = false,
  afterHeader,
  endSlot,
  testID,
}: ScrollArticleProps) {
  const { breakpoint } = useDisplay();
  const [ownStore] = useState(createMemoryBlockStateStore);
  const store = givenStore ?? ownStore;
  const [textVersion, setTextVersion] = useState(initialTextVersion);
  const observerRef = useRef(observer);
  const diagnosticsRef = useRef(diagnostics);
  useEffect(() => {
    observerRef.current = observer;
    diagnosticsRef.current = diagnostics;
  });
  const scrollRef = useRef<ScrollViewInstance>(null);
  const viewport = useReadingViewport(observer, readingInset);
  useArticleActivity(observer, paused);

  // A block inside a disclosure opens its disclosure before anything draws, so the anchor shows it.
  const [target] = useState<AnchorTarget | null>(() => {
    const resolved = anchorBlockId === undefined ? null : resolveAnchor(document, anchorBlockId);
    if (resolved !== null && resolved.openDisclosureId !== null) {
      store.set(
        { assetId: document.assetId, revision: document.revision, blockId: resolved.openDisclosureId },
        { type: 'disclosure', expanded: true },
      );
    }
    return resolved;
  });
  const { flash, onPlaced } = useAnchorRestore(target, scrollRef);

  const report = useCallback<ScrollRenderContext['report']>(
    (blockId, kind) => observerRef.current?.onBlockInteraction({ blockId, kind, at: monotonicNow() }),
    [],
  );
  const diagnose = useCallback<ScrollRenderContext['diagnose']>(
    (event) => diagnosticsRef.current?.onRenderFallback({ ...event, at: monotonicNow() }),
    [],
  );
  const context = useMemo<ScrollRenderContext>(
    () => ({
      assetId: document.assetId,
      revision: document.revision,
      store,
      carryOver: carryOverBlockIds ?? new Set<string>(),
      textVersion,
      renderMedia,
      report,
      diagnose,
      renderNested: renderNestedBlock,
    }),
    [document.assetId, document.revision, store, carryOverBlockIds, textVersion, renderMedia, report, diagnose],
  );

  const hasVisualBlocks = useMemo(() => {
    for (const { block } of walkBlocks(document.sections)) {
      if (
        block.type === 'diagram' ||
        block.type === 'chart' ||
        block.type === 'simulation' ||
        block.type === 'sequence'
      ) {
        return true;
      }
    }
    return false;
  }, [document.sections]);
  const editorial = document.template === 'editorial';
  const firstParagraph = useMemo(() => {
    for (const section of document.sections) {
      for (const block of section.blocks) if (block.type === 'paragraph') return block.id;
    }
    return null;
  }, [document.sections]);
  const measure =
    breakpoint === 'desktop' ? layout.measureDesktop : breakpoint === 'tablet' ? layout.measureTablet : undefined;
  const measured = measure === undefined ? null : { maxWidth: measure };

  return (
    <ScrollRenderProvider value={context}>
      <GestureRoot style={styles.scroll}>
        <ScrollView
          ref={scrollRef}
          testID={testID}
          {...viewport.scrollProps}
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingTop: contentInset.top, paddingBottom: contentInset.bottom }]}
        >
          <View style={[styles.item, measured]}>
            {editorial ? <EditorialHeader document={document} /> : <PosterHeader document={document} />}
          </View>
          <CorrectionNotices corrections={document.corrections} />
          <FramingNotice framing={document.framing} />
          {afterHeader === undefined ? null : <View style={[styles.item, measured]}>{afterHeader}</View>}
          {hasVisualBlocks ? (
            <View style={[styles.item, measured]}>
              <TextVersionToggle on={textVersion} onChange={setTextVersion} />
            </View>
          ) : null}
          {document.sections.flatMap((section) => [
            section.heading === null ? null : (
              <View key={`heading-${section.id}`} style={[styles.item, measured]}>
                <Text variant="heading" heading={2} style={styles.sectionHeading}>
                  {section.heading}
                </Text>
              </View>
            ),
            ...section.blocks.map((block) => (
              <BlockHost
                key={block.id}
                block={block}
                viewport={viewport}
                options={editorial && block.id === firstParagraph ? { initialCap: true } : undefined}
                highlighted={flash === block.id}
                onPlaced={onPlaced}
              />
            )),
          ])}
          <View style={[styles.item, measured]}>
            <EndMark />
          </View>
          {endSlot === undefined ? null : <View style={[styles.item, measured]}>{endSlot}</View>}
        </ScrollView>
      </GestureRoot>
    </ScrollRenderProvider>
  );
}

/**
 * A Scroll article: the document's template (poster or editorial opening), its framing and
 * corrections, every section and block through the registry, and the end mark. It scrolls itself
 * and measures what the reader sees (IntersectionObserver on the web, layout and scroll offset on
 * native) for the observer. The article is keyed by revision: a new revision mounts a fresh
 * article, so no state of the old one leaks across (block state is also stored by revision).
 */
export function ScrollArticle(props: ScrollArticleProps) {
  return <ScrollArticleBody key={`${props.document.assetId}:${props.document.revision}`} {...props} />;
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: content.paper },
  content: { paddingHorizontal: layout.gutter, gap: spacing['3.5'] },
  item: { width: '100%', alignSelf: 'center' },
  sectionHeading: { marginTop: spacing[4] },
});
