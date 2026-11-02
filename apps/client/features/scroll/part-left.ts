import type { AccountScope } from '@knowscroll/client-core';

/** How long a step forward is remembered: long enough to open the next Part on a slow connection, no longer. */
const EXPIRES_MS = 60_000;

interface Left {
  readonly part: number;
  readonly seriesId: string;
  readonly at: number;
}

/**
 * The Part each Scroll was just stepped forward from, by the Scroll's id, held per account scope (account and epoch). It
 * lives in memory only, so an account switch, a logout or a privacy reset, which each end the scope, leave nothing of it
 * behind: a new scope starts with no notes, and an ended one is not read.
 */
const notes = new WeakMap<AccountScope, Map<string, Left>>();

/**
 * Notes that the Part `part` of `seriesId` was left by a step forward to `targetAssetId`. A related move or another angle
 * is not a step forward in a series and is never noted by the caller.
 */
export function notePartLeft(
  scope: Pick<AccountScope, 'active'>,
  targetAssetId: string,
  left: { readonly part: number; readonly seriesId: string },
  now: number = Date.now(),
): void {
  if (!scope.active) return;
  const own = notes.get(scope as AccountScope) ?? new Map<string, Left>();
  own.set(targetAssetId, { ...left, at: now });
  notes.set(scope as AccountScope, own);
}

/**
 * The number of the Part a step forward just left for this Scroll, once, when the Scroll that opened is a later Part of the
 * same series and the step was a moment ago. `undefined` for a link, a reload, a later visit, another scope or another series.
 */
export function takePartLeft(
  scope: Pick<AccountScope, 'active'>,
  assetId: string,
  opened: { readonly part: number; readonly seriesId: string },
  now: number = Date.now(),
): number | undefined {
  const own = notes.get(scope as AccountScope);
  const left = own?.get(assetId);
  if (own === undefined || left === undefined || !scope.active) return undefined;
  own.delete(assetId);
  const fresh = now - left.at <= EXPIRES_MS;
  return fresh && left.seriesId === opened.seriesId && left.part < opened.part ? left.part : undefined;
}
