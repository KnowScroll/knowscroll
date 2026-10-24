import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reelFingerprints } from './fingerprint.js';
import { LEGACY_REELS_ON_RECORD } from './legacy-corpus.js';
import { ReelBriefSchema } from './script.js';

const frozenScripts = new URL('../../../../../../../content/reel-scripts/', import.meta.url);

describe('the legacy repetition corpus', () => {
  it('holds exactly the fingerprints of the frozen v1 scripts', () => {
    const recomputed = readdirSync(frozenScripts)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const script = JSON.parse(readFileSync(new URL(file, frozenScripts), 'utf8')) as { brief: unknown };
        const brief = ReelBriefSchema.parse(script.brief);
        const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
        return { label: file.replace(/\.json$/, ''), ...reelFingerprints(brief, sha256) };
      });
    const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
    expect([...LEGACY_REELS_ON_RECORD].sort(byLabel)).toEqual(recomputed.sort(byLabel));
  });
});
