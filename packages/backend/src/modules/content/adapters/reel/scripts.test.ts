import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RECIPES } from '../../domain/library/index.js';
import { checkReelScript } from '../../domain/reel/check.js';
import { findRepetition, reelFingerprints } from '../../domain/reel/fingerprint.js';
import { LEGACY_REELS_ON_RECORD } from '../../domain/reel/legacy-corpus.js';
import { reelScripts } from './scripts.js';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const scripts = [...reelScripts.entries()];

describe('the shipped Reel scripts', () => {
  it('ship four scripts, each named for the Scroll it twins', () => {
    expect(scripts.map(([name]) => name).sort()).toEqual([
      'black-hole-horizon',
      'exoplanet-transit',
      'stars-fusion',
      'tides-spring-neap',
    ]);
    for (const [name, script] of scripts) expect(script.recipe, name).toBe(name);
  });

  it.each(scripts)('%s passes the product’s own script checks', (_name, script) => {
    expect(checkReelScript(script)).toEqual([]);
    expect(script.brief.narration.length).toBe(6);
  });

  it('has one script per Scroll and a distinct Reel identity for each', () => {
    expect(new Set(scripts.map(([, script]) => script.recipe)).size).toBe(scripts.length);
    expect(new Set(scripts.map(([, script]) => script.id)).size).toBe(scripts.length);
    for (const [, script] of scripts)
      for (const source of script.brief.claimSources) {
        expect(source.assetId).toBe(RECIPES[script.recipe as keyof typeof RECIPES].assetId);
        expect(source.assetRevision).toBe(1);
      }
  });

  it('shares no fingerprint with a v1 script or with each other', () => {
    const earlier = [...LEGACY_REELS_ON_RECORD];
    for (const [name, script] of scripts) {
      const fingerprints = reelFingerprints(script.brief, sha256);
      expect(findRepetition(fingerprints, earlier), name).toBeUndefined();
      earlier.push({ label: name, ...fingerprints });
    }
  });

  it('is approved as a delegated decision, never as the owner in person', () => {
    for (const [, script] of scripts) {
      expect(script.approval.ref).toBe('D-030 delegated');
      expect(script.approval.approvedBy).toContain('delegated by owner, D-030');
    }
  });
});
