import { BLOCK_TYPES } from '@knowscroll/scroll-model';
import { z } from 'zod';

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
export const ReadingFactsSchema = z.object({
  v: z.literal(READING_FACTS_VERSION),
  /** The measures version the weights come from (`scroll-measures.v1`). */
  measuresVersion: z.string().regex(/^[a-z][a-z0-9.-]{1,39}$/),
  /** The sum of the top-level weights. */
  totalWeight: z.number().int().min(0),
  /** Estimated reading time in milliseconds at the measures' reading speed. */
  estimatedReadingMs: z.number().int().min(0),
  /** Top-level blocks in document order. */
  blocks: z.array(z.object({ id: z.string(), weight: z.number().int().min(0), type: z.enum(BLOCK_TYPES) })).max(2_000),
  /** Blocks nested in a disclosure, with the top-level block that owns each. */
  nested: z.array(z.object({ id: z.string(), owner: z.string(), type: z.enum(BLOCK_TYPES) })).max(2_000),
});

export type ReadingFacts = z.infer<typeof ReadingFactsSchema>;

/** A stable operational failure: facts cannot be recovered from the stored document. No content in diagnostics. */
export class ReadingFactsUnavailableError extends Error {
  override readonly name = 'ReadingFactsUnavailableError';
  readonly code = 'READING_FACTS_REQUIRES_REFRESH';
  constructor() {
    super('READING_FACTS_REQUIRES_REFRESH');
  }
}
