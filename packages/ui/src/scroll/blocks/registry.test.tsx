import {
  BASELINE_TYPES,
  BLOCK_TYPES,
  negotiate,
  parseCapabilities,
  parseDocument,
  type BlockType,
} from '@knowscroll/scroll-model';
import { bridgesPoster } from '../fixtures/documents';
import { SCROLL_RENDERER_CAPABILITIES, isImplemented } from './registry';

describe('the renderer registry', () => {
  it('advertises exactly the block types it renders, and always the baseline', () => {
    expect(parseCapabilities(SCROLL_RENDERER_CAPABILITIES).kind).toBe('capabilities');
    for (const type of BASELINE_TYPES) expect(isImplemented(type)).toBe(true);
    for (const type of BLOCK_TYPES) {
      expect(Object.hasOwn(SCROLL_RENDERER_CAPABILITIES.blocks, type)).toBe(isImplemented(type));
    }
    expect(SCROLL_RENDERER_CAPABILITIES.documentSchemas).toEqual(['scroll-document.v1']);
  });

  it('lets the server replace what this build does not render, listing the essential block it degraded', () => {
    const outcome = negotiate(bridgesPoster(), SCROLL_RENDERER_CAPABILITIES);
    if (outcome.kind !== 'negotiated') throw new Error(`expected a rendition, got ${outcome.kind}`);

    const unrendered = BLOCK_TYPES.filter((type: BlockType) => !isImplemented(type));
    expect(unrendered).toContain('diagram');
    expect(outcome.substitutions.map((entry) => entry.blockId)).toEqual(['diagram-load']);
    expect(outcome.degradedEssential.map((entry) => entry.blockId)).toEqual(['diagram-load']);
    // What the client receives is a valid rendition, whose hash verifies when asked.
    expect(parseDocument(outcome.document, { verify: true }).kind).toBe('valid');
  });
});
