/**
 * Epoch-scoped browser storage, mirroring apps/mobile/.../data/StateStore.kt.
 *
 * Persists only the retry envelope needed to resume a reading session or a
 * saved-Trace revisit after a reload: never the fact that "learning happened",
 * never a psychological profile (Law 11/13). Every read is checked against
 * the last-observed (universeId, privacyEpoch) pair before being trusted;
 * a changed epoch or universe is purged, never silently reused, matching the
 * ADR-0009 fence and the issue's "no restore across a changed epoch" clause.
 */
import type { FeedItem } from '../api/types.ts';

const NAMESPACE = 'ks_web_v1';
const key = (name: string) => `${NAMESPACE}:${name}`;

export type Screen = 'universe' | 'scroll' | 'revisit';

export interface ScrollSession {
  decisionId: string;
  item: FeedItem;
  privacyEpoch: number;
  universeId: string;
  clientExposureId: string;
  clientEventId: string;
  exposureId: string;
  exposureEventId: string;
  keepJobId: string;
  keepEventId: string;
  readingPosition: number;
}

export interface RevisitSession {
  eventId: string;
  assetId: string;
  privacyEpoch: number;
  universeId: string;
  revision?: number;
  readingPosition: number;
}

/**
 * The real reason the most recently kept Trace was recommended -- captured verbatim from the
 * feed item's own `reason` field at the moment Keep was accepted (ui-system.md sec.5c: the
 * growth note must carry "the real why-this-appeared reason", never an invented growth claim).
 * Scoped and purged exactly like every other private artifact here; it is evidence of what was
 * shown, the same category of fact `Universe.traces[].title` already carries, never a profile.
 */
export interface LastKept {
  eventId: string;
  title: string;
  reason: string;
  privacyEpoch: number;
  universeId: string;
}

export interface StorageBackend {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

function safeParse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** The only persisted state for this reader slice: navigation, retry envelopes, and the privacy fence. */
export class ReaderStorage {
  constructor(private readonly backend: StorageBackend) {}

  writeScreen(screen: Screen): void {
    this.backend.setItem(key('screen'), screen);
  }
  readScreen(): Screen {
    const value = this.backend.getItem(key('screen'));
    return value === 'scroll' || value === 'revisit' ? value : 'universe';
  }

  writeVisited(assetIds: ReadonlySet<string>): void {
    this.backend.setItem(key('visited'), JSON.stringify([...assetIds]));
  }
  readVisited(): Set<string> {
    return new Set(safeParse<string[]>(this.backend.getItem(key('visited'))) ?? []);
  }

  writeSession(session: ScrollSession): void {
    this.backend.setItem(key('session'), JSON.stringify(session));
  }
  readSession(): ScrollSession | null {
    return safeParse<ScrollSession>(this.backend.getItem(key('session')));
  }
  writeReadingPosition(assetId: string, position: number): void {
    const current = this.readSession();
    if (current && current.item.assetId === assetId) {
      this.writeSession({ ...current, readingPosition: position });
    }
  }
  clearSession(): void {
    this.backend.removeItem(key('session'));
  }

  writeLastKept(value: LastKept): void {
    this.backend.setItem(key('lastKept'), JSON.stringify(value));
  }
  readLastKept(): LastKept | null {
    return safeParse<LastKept>(this.backend.getItem(key('lastKept')));
  }

  writeRevisit(session: RevisitSession): void {
    this.backend.setItem(key('revisit'), JSON.stringify(session));
  }
  readRevisit(): RevisitSession | null {
    return safeParse<RevisitSession>(this.backend.getItem(key('revisit')));
  }
  clearRevisit(): void {
    this.backend.removeItem(key('revisit'));
  }

  readObservedPrivacyEpoch(): number {
    const raw = this.backend.getItem(key('privacyEpoch'));
    return raw === null ? 0 : Number(raw);
  }
  readObservedUniverseId(): string {
    return this.backend.getItem(key('privacyUniverseId')) ?? '';
  }

  /** Monotonic within a universe; a different universe resets the observed epoch outright. */
  observePrivacyState(universeId: string, epoch: number): number {
    const observed = this.readObservedUniverseId() === universeId ? Math.max(this.readObservedPrivacyEpoch(), epoch) : epoch;
    this.backend.setItem(key('privacyUniverseId'), universeId);
    this.backend.setItem(key('privacyEpoch'), String(observed));
    return observed;
  }

  /** Fail-closed purge: drop every private encounter/navigation artifact, keep the epoch fence monotonic. */
  purgePrivateState(universeId: string, epoch: number): void {
    const observed = this.readObservedUniverseId() === universeId ? Math.max(this.readObservedPrivacyEpoch(), epoch) : epoch;
    this.backend.removeItem(key('session'));
    this.backend.removeItem(key('revisit'));
    this.backend.removeItem(key('visited'));
    this.backend.removeItem(key('lastKept'));
    this.backend.setItem(key('screen'), 'universe');
    this.backend.setItem(key('privacyUniverseId'), universeId);
    this.backend.setItem(key('privacyEpoch'), String(observed));
  }
}

export function createBrowserStorage(): ReaderStorage {
  return new ReaderStorage(window.localStorage);
}

/** In-memory backend for unit tests; no jsdom/browser dependency required. */
export class MemoryStorageBackend implements StorageBackend {
  private readonly map = new Map<string, string>();
  getItem(name: string): string | null {
    return this.map.has(name) ? this.map.get(name)! : null;
  }
  setItem(name: string, value: string): void {
    this.map.set(name, value);
  }
  removeItem(name: string): void {
    this.map.delete(name);
  }
}
