import type {
  CheckAssetAudience,
  FindAssetForAction,
  ReadSavedMetadata,
  ReadSavedPageMetadata,
} from '../../content/public.js';
import type { PersonalAuthority, ReadOn } from '../../identity/public.js';

/**
 * Where Experience applies the audience of Scrolls ordered for a thread (D-049). Content decides which
 * assets have one and the ordering module who is in it; Experience only asks, wherever a person could
 * otherwise reach or learn of such a Scroll by its ID: open, read, act on, and the saved lists. Every
 * check runs on the caller's own transaction, so none takes a second connection.
 */

/** One asset: may this caller reach it? */
export function holdsOne(
  check: CheckAssetAudience,
): (on: ReadOn, authority: PersonalAuthority, assetId: string) => Promise<boolean> {
  return async (on, authority, assetId) => (await check(on, authority, [assetId])).has(assetId);
}

/** An action finds only the assets the caller may reach: a Scroll ordered for a thread is missing to anyone outside it. */
export function gateFindAsset(find: FindAssetForAction, check: CheckAssetAudience): FindAssetForAction {
  const holds = holdsOne(check);
  return async (scope, assetId) =>
    (await holds({ scope }, scope.authority, assetId)) ? find(scope, assetId) : undefined;
}

interface SavedRow {
  readonly ref: { readonly assetId: string };
  readonly availability: 'available' | 'corrected' | 'withdrawn';
  readonly metadata?: unknown;
  readonly currentAssetRevision?: number;
}

/** A saved entry the caller may not see reads as withdrawn, with no title, summary or revision, exactly like one that is gone. */
function withdrawn<Row extends SavedRow>(row: Row): Row {
  const { metadata: _metadata, currentAssetRevision: _current, ...rest } = row;
  return { ...rest, availability: 'withdrawn' } as unknown as Row;
}

async function hideUnheld<Row extends SavedRow>(
  scope: Parameters<ReadSavedMetadata>[0],
  rows: readonly Row[],
  check: CheckAssetAudience,
): Promise<readonly Row[]> {
  const shown = rows.filter((row) => row.availability !== 'withdrawn').map((row) => row.ref.assetId);
  const held = await check({ scope }, scope.authority, shown);
  return rows.map((row) => (row.availability === 'withdrawn' || held.has(row.ref.assetId) ? row : withdrawn(row)));
}

/** The saved list shows a Scroll ordered for a thread only to those still in it. */
export function gateSavedMetadata(read: ReadSavedMetadata, check: CheckAssetAudience): ReadSavedMetadata {
  return async (scope, refs) => hideUnheld(scope, await read(scope, refs), check);
}

/** The same for the saved page. */
export function gateSavedPageMetadata(read: ReadSavedPageMetadata, check: CheckAssetAudience): ReadSavedPageMetadata {
  return async (scope, refs) => hideUnheld(scope, await read(scope, refs), check);
}
