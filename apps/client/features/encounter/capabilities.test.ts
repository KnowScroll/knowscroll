import { declaredCoverSchema } from '@knowscroll/contracts';
import { ClientCapabilities } from '@knowscroll/scroll-model';
import { ENCOUNTER_CAPABILITIES } from './capabilities';

describe('what the Explore encounter declares (capabilities.ts)', () => {
  it('names every document the encounter draws: Scrolls v1, v2 and v3, its Reels, and both covers', () => {
    expect(ENCOUNTER_CAPABILITIES.documentSchemas).toEqual([
      'scroll-document.v1',
      'scroll-document.v2',
      'scroll-document.v3',
      'reel-document.v1',
      'offer-cover.v1',
      'offer-cover.v2',
    ]);
  });

  it('asks for the newest cover, a picture frame included, and stays within what the server accepts', () => {
    expect(declaredCoverSchema(ENCOUNTER_CAPABILITIES.documentSchemas)).toBe('offer-cover.v2');
    expect(ClientCapabilities.safeParse(ENCOUNTER_CAPABILITIES).success).toBe(true);
    expect(ENCOUNTER_CAPABILITIES.documentSchemas.length).toBeLessThanOrEqual(8);
  });
});
