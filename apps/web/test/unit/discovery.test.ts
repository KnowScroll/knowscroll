import { describe, expect, it } from 'vitest';
import { canRequestDiscovery, selectDiscovery } from '../../src/state/discovery.ts';
import { feedItem } from './fakeApi.ts';

const itemA = feedItem({ assetId: 'a' });
const itemB = feedItem({ assetId: 'b' });

describe('selectDiscovery', () => {
  it('returns invalid-scope even for an empty feed when universe/epoch mismatch', () => {
    const feed = { decisionId: 'd', universeId: 'other', accountRevision: 1, privacyEpoch: 5, items: [] };
    expect(selectDiscovery(feed, 'u1', 0, new Set(), undefined)).toEqual({ kind: 'invalid-scope' });
  });

  it('skips already-visited and the current asset', () => {
    const feed = { decisionId: 'd', universeId: 'u1', accountRevision: 1, privacyEpoch: 0, items: [itemA, itemB] };
    expect(selectDiscovery(feed, 'u1', 0, new Set(['a']), undefined)).toEqual({ kind: 'item', item: itemB });
    expect(selectDiscovery(feed, 'u1', 0, new Set(), 'a')).toEqual({ kind: 'item', item: itemB });
  });

  it('reaches a finite rest once every candidate is visited or current', () => {
    const feed = { decisionId: 'd', universeId: 'u1', accountRevision: 1, privacyEpoch: 0, items: [itemA, itemB] };
    expect(selectDiscovery(feed, 'u1', 0, new Set(['a', 'b']), undefined)).toEqual({ kind: 'exhausted' });
  });
});

describe('canRequestDiscovery', () => {
  it('refuses while a keep is saving, failed, or conflicted', () => {
    expect(canRequestDiscovery({ status: 'saving' }, 'idle')).toBe(false);
    expect(canRequestDiscovery({ status: 'failed', message: 'x' }, 'idle')).toBe(false);
    expect(canRequestDiscovery({ status: 'conflict', message: 'x' }, 'idle')).toBe(false);
  });
  it('refuses while discovery is already loading', () => {
    expect(canRequestDiscovery({ status: 'idle' }, 'loading')).toBe(false);
  });
  it('allows a deliberate Next once idle/kept and not loading', () => {
    expect(canRequestDiscovery({ status: 'idle' }, 'idle')).toBe(true);
    expect(canRequestDiscovery({ status: 'kept', jobId: 'j' }, 'idle')).toBe(true);
  });
});
