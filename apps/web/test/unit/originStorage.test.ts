import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSeenOrigin, markOriginSeen } from '../../src/cosmos/originStorage.ts';
import { MemoryStorageBackend, ReaderStorage } from '../../src/state/storage.ts';

const UNIVERSE = 'aaaaaaaa-0000-4000-8000-000000000000';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000000';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('origin display memory (ADR-0051 §4–§5)', () => {
  it('remembers that this browser finished or skipped the opening', () => {
    expect(hasSeenOrigin()).toBe(false);
    markOriginSeen();
    expect(hasSeenOrigin()).toBe(true);
  });

  it('remembers drawn changes per universe in the reader\'s own storage; null means first sight', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    expect(storage.readSkyPlayed(UNIVERSE)).toBeNull();
    storage.writeSkyPlayed(UNIVERSE, new Set(['a', 'b']));
    expect(storage.readSkyPlayed(UNIVERSE)).toEqual(new Set(['a', 'b']));
    expect(storage.readSkyPlayed(OTHER)).toBeNull();
    const many = Array.from({ length: 230 }, (_, i) => `delta-${i}`);
    storage.writeSkyPlayed(UNIVERSE, new Set(many));
    const played = storage.readSkyPlayed(UNIVERSE)!;
    expect(played.size).toBe(200);
    expect(played.has('delta-229')).toBe(true);
  });

  it('forgets drawn changes with the rest of the reader\'s private state (Clear, Reset, sign-out)', () => {
    const storage = new ReaderStorage(new MemoryStorageBackend());
    storage.writeSkyPlayed(UNIVERSE, new Set(['a']));
    storage.purgePrivateState(UNIVERSE, 3);
    expect(storage.readSkyPlayed(UNIVERSE)).toBeNull();
  });

  it('treats an unexpected value of the opening flag as not seen', () => {
    window.localStorage.setItem('ks_origin_v1', 'maybe');
    expect(hasSeenOrigin()).toBe(false);
  });

  it('never throws when storage refuses reads and writes (a private window, blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => markOriginSeen()).not.toThrow();
    expect(hasSeenOrigin()).toBe(false);
  });

  it('never throws when the storage object itself is inaccessible', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => markOriginSeen()).not.toThrow();
    expect(hasSeenOrigin()).toBe(false);
  });
});
