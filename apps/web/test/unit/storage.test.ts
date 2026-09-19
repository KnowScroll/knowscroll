import { describe, expect, it } from 'vitest';
import { MemoryStorageBackend, ReaderStorage, type RevisitSession, type ScrollSession } from '../../src/state/storage.ts';
import { feedItem } from './fakeApi.ts';

function session(overrides: Partial<ScrollSession> = {}): ScrollSession {
  return {
    decisionId: 'd1',
    item: feedItem(),
    privacyEpoch: 0,
    universeId: 'u1',
    clientExposureId: 'ce1',
    clientEventId: 'cv1',
    exposureId: '',
    exposureEventId: '',
    keepJobId: '',
    keepEventId: '',
    readingPosition: 0,
    ...overrides,
  };
}

describe('ReaderStorage epoch-scoped persistence', () => {
  it('round-trips a scroll retry envelope', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    const value = session({ exposureId: 'exp1' });
    storage.writeSession(value);
    expect(storage.readSession()).toEqual(value);
  });

  it('updates only the reading position for the matching asset', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    storage.writeSession(session());
    storage.writeReadingPosition(feedItem().assetId, 240);
    expect(storage.readSession()?.readingPosition).toBe(240);
    // A stale asset id (e.g. after navigating away) must not silently rewrite the envelope.
    storage.writeReadingPosition('different-asset', 900);
    expect(storage.readSession()?.readingPosition).toBe(240);
  });

  it('observes privacy epoch monotonically within the same universe', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    expect(storage.observePrivacyState('u1', 2)).toBe(2);
    expect(storage.observePrivacyState('u1', 1)).toBe(2); // never regresses within the same universe
    expect(storage.observePrivacyState('u1', 5)).toBe(5);
  });

  it('resets the observed epoch outright for a different universe', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    storage.observePrivacyState('u1', 5);
    expect(storage.observePrivacyState('u2', 0)).toBe(0);
  });

  it('purgePrivateState clears every private artifact but keeps the epoch fence monotonic', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    storage.writeScreen('scroll');
    storage.writeSession(session());
    storage.writeVisited(new Set(['a', 'b']));
    const revisit: RevisitSession = { eventId: 'e1', assetId: 'a1', privacyEpoch: 0, universeId: 'u1', readingPosition: 3 };
    storage.writeRevisit(revisit);
    storage.observePrivacyState('u1', 1);

    storage.purgePrivateState('u1', 2);

    expect(storage.readSession()).toBeNull();
    expect(storage.readRevisit()).toBeNull();
    expect(storage.readVisited().size).toBe(0);
    expect(storage.readScreen()).toBe('universe');
    expect(storage.readObservedPrivacyEpoch()).toBe(2);
    expect(storage.readObservedUniverseId()).toBe('u1');
  });

  it('never lets a read return data for a changed epoch: callers must compare epoch before trusting a cached envelope', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    storage.writeSession(session({ privacyEpoch: 0, universeId: 'u1' }));
    storage.observePrivacyState('u1', 0);
    storage.purgePrivateState('u1', 3); // epoch advanced (e.g. after a projected Keep elsewhere)
    // The raw envelope is gone entirely; there is nothing stale left to accidentally restore.
    expect(storage.readSession()).toBeNull();
    expect(storage.readObservedPrivacyEpoch()).toBe(3);
  });

  it('an unknown/garbage stored value never throws and is treated as absent', () => {
    const backend = new MemoryStorageBackend();
    backend.setItem('ks_web_v1:session', '{not json');
    const storage = new ReaderStorage(backend);
    expect(storage.readSession()).toBeNull();
  });
});
