/**
 * The prompt version of the last v2 writer (`scroll-authoring.v2`). The v2 writer is deleted (#815), but stage and main still store and
 * serve the v2 Scrolls it wrote, and each of their provenance records names this version as its production record: the publication
 * lineage (`publication-topic.ts`) and the tests of the reading side name it to read such a record. It is no longer the version of any
 * job: nothing produces a v2 Scroll.
 */
export const WRITER_V2_PROMPT_VERSION = 'scroll-writer.v22';
