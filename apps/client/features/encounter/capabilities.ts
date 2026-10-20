import { SCROLL_CAPABILITIES } from '../scroll/capabilities';

/** Formats this encounter controller can actually render, including its Reel media player. */
export const ENCOUNTER_CAPABILITIES = {
  ...SCROLL_CAPABILITIES,
  documentSchemas: [...SCROLL_CAPABILITIES.documentSchemas, 'reel-document.v1'],
};
