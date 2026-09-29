import { describe, expect, it } from 'vitest';
import { feedResponse } from '../../src/api/types.ts';

const reel = {
  assetId: '10000000-0000-4000-8000-000000000002',
  revision: 1,
  kind: 'Reel',
  title: 'A verified test Reel',
  summary: 'A disposable media fixture.',
  truthState: 'synthesis',
  generatedLabel: true,
  simulated: true,
  mediaUrl: `/v1/media/${'a'.repeat(64)}`,
  durationSeconds: 7.25,
  aspect: '1080:1920',
  reason: 'An eligible test encounter.',
} as const;

const response = (item: unknown) => ({
  decisionId: '10000000-0000-4000-8000-000000000003',
  universeId: '10000000-0000-4000-8000-000000000004',
  accountRevision: 0,
  privacyEpoch: 0,
  items: [item],
});

describe('Reel feed boundary', () => {
  it('accepts the gated Reel shape returned by the API', () => {
    expect(feedResponse.parse(response(reel)).items[0]?.kind).toBe('Reel');
  });

  it('refuses external or script media addresses and unknown fields', () => {
    for (const mediaUrl of ['https://example.test/video.mp4', 'javascript:alert(1)', '/v1/media/short']) {
      expect(feedResponse.safeParse(response({ ...reel, mediaUrl })).success).toBe(false);
    }
    expect(feedResponse.safeParse(response({ ...reel, enginePath: '/private/engine.mp4' })).success).toBe(false);
    expect(feedResponse.safeParse(response({ ...reel, sourceUrl: 'https://example.test/source' })).success).toBe(false);
  });
});
