/**
 * The version of the document v3 writer's instructions and output contract. The v3 writer imports it for its role, its stored
 * production record and the publication lineage (`publication-topic.ts`), which expects exactly this string on a v3 revision.
 * `versions.test.ts` pairs it with `SCROLL_PRODUCTION_V3_VERSION`, so a new writer cannot reuse the old writer's takes. Kept in a
 * module of its own so the production versions and the lineage can name it before the writer exists.
 */
export const WRITER_V3_PROMPT_VERSION = 'scroll-writer-v3.v1';
