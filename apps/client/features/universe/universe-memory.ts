import type { AccountScope } from '@knowscroll/client-core';
import type { SceneKind } from '@knowscroll/scene-core';
import { boundedFrame, type UniverseFrame } from './universe-camera';

/** The place the ship is parked at: the last system, planet or region the person flew to. */
export interface LastPlace {
  readonly id: string;
  readonly label: string;
  readonly kind: SceneKind;
}

/**
 * What the Universe remembers on this device, per account and privacy epoch: the camera, the
 * Lately lens and the ship's place. It is navigation state only. It is never sent anywhere, never
 * evidence, and is purged with the scope on logout, account switch and privacy reset.
 */
export interface UniverseMemory {
  readonly focusId: string | null;
  readonly frame: UniverseFrame;
  readonly lately: boolean;
  readonly lastPlace: LastPlace | undefined;
  /** Epoch milliseconds when the screen was last on show. */
  readonly seenAt: number;
}

const KEY = 'universe.view.v1';
/** After this long away the camera starts framed on everything (U01 "returning after absence"). */
export const ABSENCE_MS = 3 * 24 * 60 * 60 * 1000;

const KINDS: readonly string[] = ['system', 'star', 'planet', 'region'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Reads the stored memory; anything malformed or oversized is treated as absent. */
export function loadUniverseMemory(scope: AccountScope): UniverseMemory | undefined {
  const raw = scope.storage.get(KEY);
  if (!raw || raw.length > 4096) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value['frame']) || typeof value['seenAt'] !== 'number') return undefined;
    const frame = value['frame'];
    const place = value['lastPlace'];
    const lastPlace =
      isRecord(place) &&
      typeof place['id'] === 'string' &&
      typeof place['label'] === 'string' &&
      typeof place['kind'] === 'string' &&
      KINDS.includes(place['kind'])
        ? ({
            id: place['id'],
            label: place['label'].slice(0, 120),
            kind: place['kind'] as SceneKind,
          } satisfies LastPlace)
        : undefined;
    return {
      focusId: typeof value['focusId'] === 'string' ? value['focusId'] : null,
      frame: boundedFrame({
        x: Number(frame['x']),
        y: Number(frame['y']),
        scale: Number(frame['scale']),
      }),
      lately: value['lately'] === true,
      lastPlace,
      seenAt: value['seenAt'],
    };
  } catch {
    return undefined;
  }
}

export function saveUniverseMemory(scope: AccountScope, memory: UniverseMemory): void {
  try {
    scope.storage.set(KEY, JSON.stringify(memory));
  } catch {
    // Storage may be full or blocked; the camera is a convenience, so the screen carries on without it.
  }
}

export const isAbsent = (memory: UniverseMemory | undefined, now: number) =>
  memory !== undefined && now - memory.seenAt >= ABSENCE_MS;
