import { describe, expect, it } from 'vitest';
import {
  decideReject,
  decideRelease,
  MAX_REJECT_REASON_CHARS,
  parseRejectReason,
  type ReleaseFacts,
  type ReviewState,
} from './review.js';

const facts = (overrides: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  review: 'held',
  assetStatus: 'admitted',
  servedRevision: 1,
  revision: 2,
  ...overrides,
});

describe('releasing a held revision (D-138)', () => {
  it('releases a held revision that is newer than the one served', () => {
    expect(decideRelease(facts())).toEqual({ kind: 'release' });
  });

  it('releases the first revision of an asset that has never served one, whatever its stale pointer says', () => {
    expect(decideRelease(facts({ assetStatus: 'held', servedRevision: 1, revision: 1 }))).toEqual({ kind: 'release' });
  });

  it('does nothing the second time', () => {
    expect(decideRelease(facts({ review: 'released' }))).toEqual({ kind: 'already_released' });
  });

  it('refuses a revision that never went through the gate, a rejected one and a withdrawn asset', () => {
    expect(decideRelease(facts({ review: undefined }))).toEqual({ kind: 'refused', reason: 'not_under_review' });
    expect(decideRelease(facts({ review: 'rejected' }))).toEqual({ kind: 'refused', reason: 'revision_rejected' });
    expect(decideRelease(facts({ assetStatus: 'withdrawn' }))).toEqual({ kind: 'refused', reason: 'asset_withdrawn' });
  });

  it('never moves a served asset backwards or sideways', () => {
    for (const revision of [1, 2])
      expect(decideRelease(facts({ servedRevision: 2, revision }))).toEqual({
        kind: 'refused',
        reason: 'not_newer_than_served',
      });
  });
});

describe('rejecting a held revision (D-138)', () => {
  it('rejects only a held revision, and does nothing the second time', () => {
    const decisions = (['held', 'rejected', 'released', undefined] as (ReviewState | undefined)[]).map(decideReject);
    expect(decisions).toEqual([
      { kind: 'reject' },
      { kind: 'already_rejected' },
      { kind: 'refused', reason: 'revision_released' },
      { kind: 'refused', reason: 'not_under_review' },
    ]);
  });

  it('wants a reason of one to 500 characters, trimmed', () => {
    expect(parseRejectReason('  A claim about Uranus is not in the page.  ')).toBe(
      'A claim about Uranus is not in the page.',
    );
    expect(parseRejectReason(undefined)).toBeUndefined();
    expect(parseRejectReason('   ')).toBeUndefined();
    expect(parseRejectReason('x'.repeat(MAX_REJECT_REASON_CHARS))).toHaveLength(MAX_REJECT_REASON_CHARS);
    expect(parseRejectReason('x'.repeat(MAX_REJECT_REASON_CHARS + 1))).toBeUndefined();
  });
});
