/**
 * The prompt version of the last v1 writer (`scroll-writer.v13`). The v1 writer is deleted (#818), but stage and main still store and
 * serve the v1 Scrolls it wrote, and each of their provenance records names this version as its production record: the publication
 * lineage (`publication-topic.ts`) names it to read such a record. It is no longer the version of any job: nothing produces a v1 Scroll.
 */
export const WRITER_PROMPT_VERSION = 'scroll-writer.v13';
