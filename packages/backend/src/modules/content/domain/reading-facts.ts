/** Version of the stored reading facts of a v1 document (and of a Reel). A new shape gets a new version (blueprint §5). */
export const READING_FACTS_VERSION = 2;

/** Version of the reading facts of a `scroll-document.v2`: a stop is the unit of reading (D-128). */
export const READING_FACTS_V3_VERSION = 3;

/**
 * How one reading unit comes to count as read. A unit without a rule counts as v1 always has: it was
 * visible long enough while the article was active (the qualification policy's own minimum).
 */
export type SeenRule =
  /** Visible, while the article was active, for at least this long. A stop's reading time scales with its words. */
  | { readonly kind: 'visible'; readonly minVisibleMs: number }
  /** Reported as locked in or revealed (a call). Visibility alone does not count it, and neither does the option picked. */
  | { readonly kind: 'interaction'; readonly interactions: readonly string[] };

/**
 * What the evidence module needs to qualify a reading of one Scroll revision, derived by content
 * at admission from the document's code-set measures (`scroll-measures.v1`, or `.v2` for a v2
 * document): the weight of each top-level block (or stop) in word-equivalents (so a run of tiny
 * headings never dominates coverage, blueprint §8), which top-level block owns each nested block,
 * and the reading estimate.
 *
 * Plain data on purpose: it crosses the module boundary through `public.ts` and is stored beside
 * the revision as `content.asset_revisions.reading_facts`. It is a derived view with one owner
 * (content); nothing edits it independently of the document.
 */
export interface ReadingFacts {
  /** 2: a v1 document or a Reel. 3: a v2 document, whose blocks are its stops and calls. */
  readonly v: typeof READING_FACTS_VERSION | typeof READING_FACTS_V3_VERSION;
  /** Present only for an admitted Reel; no Scroll weighting is used. */
  readonly reelDurationMs?: number;
  /** The measures version the weights come from (`scroll-measures.v1` or `.v2`). */
  readonly measuresVersion: string;
  readonly totalWeight: number;
  readonly estimatedReadingMs: number;
  /** Runtime block kinds are validated by content's storage adapter. A v2 document's are `stop`, `call_it` and `final_call`. */
  readonly blocks: readonly {
    readonly id: string;
    readonly weight: number;
    readonly type: string;
    /** Always present in facts v3; v2 facts leave every block to the policy's default rule. */
    readonly seen?: SeenRule;
  }[];
  readonly nested: readonly { readonly id: string; readonly owner: string; readonly type: string }[];
}

/** A stable operational failure: facts cannot be recovered from the stored document. No content in diagnostics. */
export class ReadingFactsUnavailableError extends Error {
  override readonly name = 'ReadingFactsUnavailableError';
  readonly code = 'READING_FACTS_REQUIRES_REFRESH';
  constructor() {
    super('READING_FACTS_REQUIRES_REFRESH');
  }
}
