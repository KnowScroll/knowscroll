import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  blockStateProblems,
  canonicalJson,
  defaultBlockState,
  type AnyBlock,
  type BlockState,
  type NestedBlock,
} from './model';
import type { InteractionBlockType, InteractionKindOf, ScrollRenderDiagnostic } from './observer';
import type { ScrollMediaRenderer } from './media';
import type { ScrollBlockKey, ScrollBlockStateStore } from './state';

/**
 * What every block of one article reads: which revision it is (state is stored by revision and
 * block id), the state store, whether the reader asked for the text versions, and where a block
 * reports a deliberate interaction or a fallback.
 */
export interface ScrollRenderContext {
  readonly assetId: string;
  readonly revision: number;
  readonly store: ScrollBlockStateStore;
  /** Block ids whose state from the previous revision stays valid on this one (the package's anchor map says unchanged). */
  readonly carryOver: ReadonlySet<string>;
  /** "Text version of diagrams": visual blocks show their text alternative. */
  readonly textVersion: boolean;
  /** Draws admitted media, or returns null for its placeholder. */
  readonly renderMedia: ScrollMediaRenderer | undefined;
  /**
   * A deliberate interaction with a block (never a raw gesture): the block's type and one of the
   * kinds the package declares for that type, so a renderer cannot report another type's kind.
   */
  readonly report: <T extends InteractionBlockType>(blockId: string, blockType: T, kind: InteractionKindOf<T>) => void;
  /** A block rendered its readable stand-in. */
  readonly diagnose: (event: Omit<ScrollRenderDiagnostic, 'at'>) => void;
  /** The reader pressed Retry on a block that failed to render (a diagnostic, not an interaction). */
  readonly retried: (blockId: string, blockType: string) => void;
  /** Renders a block nested in another (a disclosure's children) the way the article renders any block. */
  readonly renderNested: (block: NestedBlock) => ReactNode;
}

const ScrollRenderContextValue = createContext<ScrollRenderContext | null>(null);

export const ScrollRenderProvider = ScrollRenderContextValue.Provider;

export function useScrollRender(): ScrollRenderContext {
  const context = useContext(ScrollRenderContextValue);
  if (context === null) throw new Error('A Scroll block must render inside a ScrollArticle');
  return context;
}

interface ResolvedState {
  readonly state: BlockState | null;
  /** This revision started from the block's default because the previous revision's state does not carry over. */
  readonly reset: boolean;
  /** The state to write under the current revision after resolving (a carried-over state). */
  readonly persist: boolean;
}

function resolveBlockState(block: AnyBlock, key: ScrollBlockKey, context: ScrollRenderContext): ResolvedState {
  const initial = defaultBlockState(block);
  if (initial === null) return { state: null, reset: false, persist: false };
  const stored = context.store.get(key);
  if (stored !== null && blockStateProblems(block, stored).length === 0) {
    return { state: stored, reset: false, persist: false };
  }
  // Nothing valid for this revision. A new revision never reads an old revision's values unless
  // the package declared the block unchanged (`carryOver`); otherwise the reader is told.
  const earlier = stored === null ? context.store.earlier(key) : null;
  if (earlier === null) return { state: initial, reset: false, persist: false };
  if (context.carryOver.has(block.id) && blockStateProblems(block, earlier.state).length === 0) {
    return { state: earlier.state, reset: false, persist: true };
  }
  return { state: initial, reset: canonicalJson(earlier.state) !== canonicalJson(initial), persist: false };
}

export interface BlockStateHandle {
  /** The reader's state for this block, or null for a block without state. */
  readonly state: BlockState | null;
  readonly setState: (next: BlockState) => void;
  /** Back to the block's authored start, forgetting the stored state. */
  readonly reset: () => void;
  /** The block started over because its revision changed: show the notice until the reader acts. */
  readonly resetNotice: boolean;
  readonly dismissNotice: () => void;
}

/** The reader's state of one block, kept by (article revision, block id) in the article's store. */
export function useBlockState(block: AnyBlock): BlockStateHandle {
  const context = useScrollRender();
  const [key] = useState<ScrollBlockKey>(() => ({
    assetId: context.assetId,
    revision: context.revision,
    blockId: block.id,
  }));
  const [resolved] = useState(() => resolveBlockState(block, key, context));
  const [state, setStateValue] = useState(resolved.state);
  const [notice, setNotice] = useState(resolved.reset);
  const storeRef = useRef(context.store);
  useEffect(() => {
    storeRef.current = context.store;
  });
  useEffect(() => {
    if (resolved.persist && resolved.state !== null) storeRef.current.set(key, resolved.state);
  }, [key, resolved]);

  const setState = useCallback(
    (next: BlockState) => {
      setStateValue(next);
      setNotice(false);
      storeRef.current.set(key, next);
    },
    [key],
  );
  const reset = useCallback(() => {
    storeRef.current.clear(key);
    setStateValue(defaultBlockState(block));
    setNotice(false);
  }, [key, block]);
  const dismissNotice = useCallback(() => setNotice(false), []);
  return { state, setState, reset, resetNotice: notice, dismissNotice };
}
