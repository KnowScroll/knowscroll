import { STAGE_CAPABILITIES } from '../scroll/capabilities';

/** Formats this encounter controller can actually render: v1 and v2 Scrolls, and its Reel media player. */
export const ENCOUNTER_CAPABILITIES = {
  ...STAGE_CAPABILITIES,
  documentSchemas: [...STAGE_CAPABILITIES.documentSchemas, 'reel-document.v1'],
};
