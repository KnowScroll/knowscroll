import { capabilitiesFor, EVERY_READER } from '../scroll/scroll-readers';

const SCROLLS = capabilitiesFor(EVERY_READER);

/** Formats this encounter controller can actually render: v1 and v2 Scrolls, and its Reel media player. */
export const ENCOUNTER_CAPABILITIES = {
  ...SCROLLS,
  documentSchemas: [...SCROLLS.documentSchemas, 'reel-document.v1'],
};
