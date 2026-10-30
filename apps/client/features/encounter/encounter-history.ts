import type { AccountScope, ReelRecorder, ScrollRecorder } from '@knowscroll/client-core';
import type { EncounterOffer, ExposureContextResponse, ReelDocument } from '@knowscroll/contracts';
import type { ReelLocalPosition, ScrollLocalPosition } from '@knowscroll/ui';
import type { AnyOpenedScroll } from '../scroll/scroll-session';

export type PrivatePosition = { kind: 'scroll'; value: ScrollLocalPosition } | ({ kind: 'reel' } & ReelLocalPosition);
export type EncounterEntry = {
  readonly offer: EncounterOffer;
  readonly exposureId: string;
  readonly sessionId: string;
  context: ExposureContextResponse;
  position?: PrivatePosition;
  /** Keep positions never enter the legacy asset/revision-only resume store. */
  keepOrigin?: boolean;
  restored: boolean;
  /**
   * Set only when a sheet over a playing Reel closes: the Reel never left, so playback resumes where it
   * was (D-006 k). Back, a trail jump and a tab detour return paused. Cleared when the entry is parked.
   */
  resumePlaying?: boolean;
  started: boolean;
  suspended: boolean;
  disposed: boolean;
  /** Bound only while the actual renderer is mounted. Capture happens before pause/unmount. */
  surface?: { capture(): PrivatePosition | undefined; pause(): void };
} & (
  | { kind: 'scroll'; scroll: AnyOpenedScroll; recorder: ScrollRecorder }
  | {
      kind: 'reel';
      document: ReelDocument;
      recorder: ReelRecorder;
      mediaGrant?: { path: string; expiresAt: string };
      /** Exact retained entry only, including while its position is unavailable during replacement. */
      muted?: boolean;
    }
);

const resumeKey = (assetId: string, revision: number) => `encounter.resume.${assetId}.${String(revision)}`;

/** Private retained-entry state only; late callbacks cannot repopulate a disposed scope. */
export function retainReelMuted(scope: Pick<AccountScope, 'active'>, entry: EncounterEntry, muted: boolean) {
  if (scope.active && !entry.disposed && entry.kind === 'reel') entry.muted = muted;
}

export function writeResume(
  scope: Pick<AccountScope, 'active' | 'storage'>,
  assetId: string,
  revision: number,
  position: PrivatePosition,
) {
  // Sound/play intent belongs to this encounter, never a future visit's durable resume record.
  const stored = position.kind === 'reel' ? { kind: 'reel', positionMs: position.positionMs } : position;
  if (scope.active) scope.storage.set(resumeKey(assetId, revision), JSON.stringify(stored));
}

/** Only exact-revision private positions are durable. History, grants and lineage remain in memory. */
export function readResume(scope: Pick<AccountScope, 'active' | 'storage'>, assetId: string, revision: number) {
  if (!scope.active) return undefined;
  try {
    const raw = scope.storage.get(resumeKey(assetId, revision));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PrivatePosition>;
    if (
      value.kind === 'reel' &&
      typeof value.positionMs === 'number' &&
      Number.isFinite(value.positionMs) &&
      value.positionMs >= 0
    )
      return { kind: 'reel', positionMs: value.positionMs, playing: false, muted: false } as const;
    if (
      value.kind === 'scroll' &&
      value.value?.assetId === assetId &&
      value.value.revision === revision &&
      typeof value.value.blockId === 'string' &&
      Number.isFinite(value.value.offsetWithinBlock) &&
      value.value.offsetWithinBlock >= 0
    )
      return { kind: 'scroll', value: value.value } as const;
  } catch {
    /* A malformed private resume record is ignored. */
  }
  return undefined;
}

export function createEncounterHistory(
  scope: Pick<AccountScope, 'active' | 'storage'>,
  limit = 20,
  onCapture?: (entry: EncounterEntry, position: PrivatePosition) => void,
) {
  const entries: EncounterEntry[] = [];
  let cursor = -1;
  let ended = false;
  const current = () => entries[cursor];
  const capture = () => {
    const entry = current();
    if (!entry || ended) return;
    const position = entry.surface?.capture();
    if (scope.active && position) {
      entry.position = position;
      onCapture?.(entry, position);
      if (!entry.keepOrigin) writeResume(scope, entry.offer.assetId, entry.offer.assetRevision, position);
    }
  };
  const park = () => {
    const entry = current();
    if (!entry || ended) return;
    // These calls are deliberately synchronous and ordered. React cleanup is too late for SDK geometry.
    capture();
    entry.surface?.pause();
    if (entry.started && !entry.suspended) {
      entry.recorder.suspend();
      entry.suspended = true;
    }
    entry.surface = undefined;
    entry.resumePlaying = false;
  };
  /** Back, a trail jump and a return from another tab restore an entry paused, whatever it was doing when it was left (E01: no sound after a detour). */
  const returnPaused = (entry: EncounterEntry) => {
    entry.restored = true;
    entry.resumePlaying = false;
    if (entry.position?.kind === 'reel') entry.position = { ...entry.position, playing: false };
  };
  const endEntry = (entry: EncounterEntry) => {
    if (entry.disposed) return;
    entry.disposed = true;
    entry.surface?.pause();
    entry.surface = undefined;
    entry.recorder.end();
    if (entry.keepOrigin) entry.position = undefined;
    if (entry.kind === 'reel') {
      entry.mediaGrant = undefined;
      entry.muted = undefined;
      entry.position = undefined;
    }
  };
  return {
    current,
    list: () => entries.slice(0, cursor + 1),
    canBack: () => cursor > 0,
    capture,
    park,
    returnPaused,
    push(entry: EncounterEntry) {
      if (ended || !scope.active) {
        endEntry(entry);
        return;
      }
      park();
      entries.splice(cursor + 1).forEach(endEntry);
      entries.push(entry);
      if (entries.length > limit) endEntry(entries.shift()!);
      cursor = entries.length - 1;
    },
    back() {
      if (ended || !scope.active || cursor <= 0) return false;
      park();
      cursor -= 1;
      returnPaused(entries[cursor]!);
      return true;
    },
    restore(exposureId: string) {
      const index = entries.findIndex((entry) => entry.exposureId === exposureId);
      if (ended || !scope.active || index < 0 || index >= cursor) return false;
      park();
      cursor = index;
      returnPaused(entries[cursor]!);
      return true;
    },
    end() {
      if (ended) return;
      park();
      ended = true;
      entries.forEach(endEntry);
      entries.length = 0;
      cursor = -1;
    },
  };
}
