import {
  BASELINE_TYPES,
  BLOCK_TYPES,
  FULL_V1_CAPABILITIES,
  negotiate,
  parseCapabilities,
  parseDocument,
} from '@knowscroll/scroll-model';
import { bridgesPoster, experimentsPoster } from '../fixtures/documents';
import { SCROLL_RENDERER_CAPABILITIES, isImplemented } from './registry';

describe('the renderer registry', () => {
  it('renders every block type of scroll-document.v1 and advertises exactly that', () => {
    expect(parseCapabilities(SCROLL_RENDERER_CAPABILITIES).kind).toBe('capabilities');
    for (const type of BASELINE_TYPES) expect(isImplemented(type)).toBe(true);
    for (const type of BLOCK_TYPES) expect(isImplemented(type)).toBe(true);
    expect(SCROLL_RENDERER_CAPABILITIES).toEqual(FULL_V1_CAPABILITIES);
  });

  it('asks the server for nothing to be replaced: a full rendition is the stored revision itself', () => {
    for (const document of [bridgesPoster(), experimentsPoster()]) {
      const outcome = negotiate(document, SCROLL_RENDERER_CAPABILITIES);
      if (outcome.kind !== 'negotiated') throw new Error(`expected a rendition, got ${outcome.kind}`);
      expect(outcome.substitutions).toEqual([]);
      expect(outcome.degradedEssential).toEqual([]);
      expect(outcome.document).toBe(document);
      expect(parseDocument(outcome.document, { verify: true }).kind).toBe('valid');
    }
  });
});
