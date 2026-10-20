import { describe, expect, it } from 'vitest';
import { ReelDocumentSchema, ReelPlaybackPayloadSchema } from './index.js';

describe('bounded Reel wire contracts', () => {
  it('accepts paired continuous samples and rejects seeks, long samples and unbounded payloads', () => {
    const sample = { activeMs: [100, 1100], mediaMs: [500, 1500] };
    expect(ReelPlaybackPayloadSchema.safeParse({ samples: [sample] }).success).toBe(true);
    for (const samples of [
      [{ activeMs: [100, 1100], mediaMs: [500, 5000] }],
      [{ activeMs: [100, 1700], mediaMs: [500, 2100] }],
      [{ activeMs: [100, 1100], mediaMs: [1500, 500] }],
      [{ activeMs: [100, 1100], mediaMs: [59900, 60900] }],
      Array.from({ length: 65 }, () => sample),
      [{ ...sample, text: 'private material' }],
    ])
      expect(ReelPlaybackPayloadSchema.safeParse({ samples }).success).toBe(false);
  });

  it('keeps the media identity logical and bounded without accepting a provider URL or extra provenance', () => {
    const document = {
      schemaVersion: 'reel-document.v1',
      assetId: '0199f0a0-0000-7000-8000-000000000004',
      revision: 1,
      title: 'A fixture Reel',
      summary: 'A wire contract fixture, never product activity.',
      language: 'en',
      truthLabel: 'generated',
      fixture: true,
      captions: 'burned_in',
      mediaKey: `sha256/aa/${'a'.repeat(64)}.mp4`,
      durationMs: 30000,
      width: 768,
      height: 1366,
    };
    expect(ReelDocumentSchema.safeParse(document).success).toBe(true);
    for (const invalid of [
      { ...document, mediaKey: 'https://provider.invalid/private.mp4' },
      { ...document, mediaKey: '../outside.mp4' },
      { ...document, durationMs: 60001 },
      { ...document, provenance: { request: 'private' } },
    ])
      expect(ReelDocumentSchema.safeParse(invalid).success).toBe(false);
  });
});
