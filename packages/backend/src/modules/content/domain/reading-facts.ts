/** Version of the stored reading facts below. A new shape gets a new version (blueprint §5). */
export const READING_FACTS_VERSION = 2;

/**
 * What the evidence module needs to qualify a reading of one Scroll revision, derived by content
 * at admission from the document's code-set measures (`scroll-measures.v1`): the weight of each
 * top-level block in word-equivalents (so a run of tiny headings never dominates coverage,
 * blueprint §8), which top-level block owns each nested block, and the reading estimate.
 *
 * Plain data on purpose: it crosses the module boundary through `public.ts` and is stored beside
 * the revision as `content.asset_revisions.reading_facts`. It is a derived view with one owner
 * (content); nothing edits it independently of the document.
 */
export interface ReadingFacts {
  readonly v: typeof READING_FACTS_VERSION;
  /** The measures version the weights come from (`scroll-measures.v1`). */
  readonly measuresVersion: string;
  readonly totalWeight: number;
  readonly estimatedReadingMs: number;
  /** Runtime block kinds are validated by content's storage adapter. */
  readonly blocks: readonly { readonly id: string; readonly weight: number; readonly type: string }[];
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
