/**
 * The version of the document v3 writer's instructions and output contract: the prompt version in a stored v3 revision's
 * production record (`stored-v3.ts`, the writer plan) and the one the publication lineage (`publication-topic.ts`) expects on it.
 * v2 (D-438): the compile leaves out a link it cannot place instead of refusing the Scroll, so the writer accepts replies v1 refused.
 * The role's own version (`scroll-writer-v3a.v1`) is different on purpose: it names the arm in the attempt ledger, and its
 * output contract is still the one reply of arm (a); the attempts of a v2 take are told apart by the run's policy version.
 * `versions.test.ts` pairs this string with `SCROLL_PRODUCTION_V3_VERSION`, so a new writer cannot reuse the old writer's takes.
 * Kept in a module of its own so the production versions and the lineage can name it without loading the writer.
 */
export const WRITER_V3_PROMPT_VERSION = 'scroll-writer-v3.v2';

/** The prompt version of the writer that ran under `scroll-production-v3.v1`: the revisions it wrote (the first five on dev) still name it. */
export const WRITER_V3_PROMPT_VERSION_V1 = 'scroll-writer-v3.v1';
