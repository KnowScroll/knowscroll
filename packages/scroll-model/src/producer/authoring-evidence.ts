/**
 * The evidence a writer may cite. `claimIdOf` maps a handle the writer sees (`e1`) to a claim id;
 * `quoteOf` maps a claim id to the source text it stands for.
 */
export interface AuthoringEvidence {
  readonly claimIdOf: ReadonlyMap<string, string>;
  readonly quoteOf: ReadonlyMap<string, string>;
  /** The document must cite at least this many distinct passages. */
  readonly minDistinctCitations: number;
}
