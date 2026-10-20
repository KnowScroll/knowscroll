import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { content, layout } from '@knowscroll/design-tokens';
import { fallbackTextOf, isInteractiveBlock, parseBlock, type AnyBlock } from '@knowscroll/scroll-model';
import { useDisplay } from '../../display/display';
import { useScrollRender } from '../context';
import { isParsedBlock } from '../prepare';
import { useBlockReading } from '../reading/reading-viewport';
import type { ReadingViewport } from '../reading/types';
import { BlockBoundary, FallbackView } from './fallback';
import { renderBlock, type RenderOptions } from './registry';

/** The readable text of a block, whatever state its data is in. */
function safeFallbackText(block: AnyBlock, envelopeText: string | null): string {
  if (envelopeText !== null) return envelopeText;
  try {
    return fallbackTextOf(block);
  } catch {
    return "This part of the Scroll can't be shown right now.";
  }
}

/**
 * One block, with every way it can fail covered: a block the package does not accept (a defensive
 * `parseBlock`, skipped for blocks `prepareScrollDocument` already parsed), an unknown type or
 * version, and a throw while rendering (an error boundary, with Retry). In each case the reader
 * gets the block's own text instead of a blank, and the host records a diagnostic.
 */
export function BlockBody({ block, options }: { readonly block: AnyBlock; readonly options?: RenderOptions }) {
  const context = useScrollRender();
  const [attempt, setAttempt] = useState(0);
  const outcome = useMemo(() => (isParsedBlock(block) ? null : parseBlock(block)), [block]);
  const rejected = outcome !== null && outcome.kind !== 'block';
  const diagnose = context.diagnose;
  const blockId = block.id;
  const blockType = block.type;
  const reason = rejected
    ? outcome.kind === 'unsupported'
      ? outcome.reason === 'unknown-type'
        ? 'unknown-type'
        : 'unknown-version'
      : 'invalid-block'
    : null;
  useEffect(() => {
    if (reason !== null) diagnose({ blockId, blockType, reason });
  }, [diagnose, blockId, blockType, reason]);

  if (outcome !== null && outcome.kind !== 'block') {
    return (
      <FallbackView
        blockType={blockType}
        text={safeFallbackText(block, outcome.envelope.fallbackText)}
        cause={outcome.kind === 'unsupported' ? 'update' : 'load'}
      />
    );
  }
  return (
    <BlockBoundary
      key={attempt}
      onError={() => diagnose({ blockId, blockType, reason: 'render-error' })}
      fallback={
        <FallbackView
          blockType={blockType}
          text={safeFallbackText(block, null)}
          cause="load"
          onRetry={() => {
            context.report(blockId, 'retry');
            setAttempt((value) => value + 1);
          }}
        />
      }
    >
      {renderBlock(block, options)}
    </BlockBoundary>
  );
}

/** Nested blocks (a disclosure's children) are guarded one by one. */
export function renderNestedBlock(block: AnyBlock): ReactNode {
  return <BlockBody key={block.id} block={block} />;
}

export interface BlockHostProps {
  readonly block: AnyBlock;
  readonly viewport: ReadingViewport;
  readonly options?: RenderOptions;
  /** The block was just restored from an anchor: it flashes on the highlight ground. */
  readonly highlighted: boolean;
  /** Where the block starts inside the scroll content (for anchors). */
  readonly onPlaced: (blockId: string, top: number) => void;
}

/**
 * A top-level block's wrapper: the stable anchor (`block-<id>`), the reading measure (a column of
 * 500 px on tablets and 680 px on desktop, 880 for interactive blocks), visibility reporting and
 * the anchor flash.
 */
export function BlockHost({ block, viewport, options, highlighted, onPlaced }: BlockHostProps) {
  const { breakpoint } = useDisplay();
  const { onLayout: onReadingLayout, ref } = useBlockReading(viewport, block.id);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onReadingLayout?.(event);
      onPlaced(block.id, event.nativeEvent.layout.y);
    },
    [onReadingLayout, onPlaced, block.id],
  );
  const width =
    breakpoint === 'desktop'
      ? isInteractiveBlock(block) || block.type === 'code'
        ? layout.blockDesktop
        : layout.measureDesktop
      : breakpoint === 'tablet'
        ? layout.measureTablet
        : undefined;
  return (
    <View
      ref={ref}
      testID={`block-${block.id}`}
      nativeID={`block-${block.id}`}
      onLayout={onLayout}
      style={[styles.host, width === undefined ? null : { maxWidth: width }, highlighted ? styles.flash : null]}
    >
      <BlockBody block={block} {...(options === undefined ? {} : { options })} />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { width: '100%', alignSelf: 'center' },
  flash: { backgroundColor: content.highlight, boxShadow: `0px 0px 0px 6px ${content.highlight}` },
});
