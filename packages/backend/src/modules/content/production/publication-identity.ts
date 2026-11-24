import type { Framing } from '@knowscroll/scroll-model';
import type { LibraryRecipe } from '../domain/library/plan.js';

/** What the Scroll is: a library explanation, a what-if, another perspective, or the answer to one person's question. */
export type WriterMode = 'library' | 'what_if' | 'perspective' | 'question';

/**
 * The rich block a recipe asks for besides prose. `comparison` is the quiet default; the others
 * make the Scroll interactive or data-driven.
 */
export type WriterFormat = 'plain' | 'comparison' | 'diagram' | 'simulation' | 'chart' | 'timeline' | 'sequence';

/** The format a recipe asks for. A recipe may name its preferred rich block; otherwise interactive means a diagram. */
export function writerFormatOf(recipe: {
  readonly interactive: boolean;
  readonly interactiveKind?: WriterFormat | null;
}): WriterFormat {
  return recipe.interactiveKind ?? (recipe.interactive ? 'diagram' : 'comparison');
}

/**
 * Who a Scroll is, as publication states it: the asset and explanation it is, the kicker and the
 * framing. Code chooses them (a library recipe's, or an order's); the writer never does.
 */
export interface PublicationIdentity {
  readonly assetId: string;
  readonly explanationUnitId: string;
  readonly kicker: string;
  readonly framing: Framing;
}

/** The identity of a library recipe's Scroll: factual, with the recipe's own asset and explanation. */
export function libraryIdentity(recipe: Pick<LibraryRecipe, 'assetId' | 'explanationUnitId'>): PublicationIdentity {
  return {
    assetId: recipe.assetId,
    explanationUnitId: recipe.explanationUnitId,
    kicker: 'A closer look',
    framing: { kind: 'factual' },
  };
}
