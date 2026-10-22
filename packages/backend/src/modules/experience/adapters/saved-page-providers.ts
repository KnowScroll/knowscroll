import type { FenceOwnAccount, WithPersonalScope } from '../../identity/public.js';
import { makeSavedPage, type SavedCursorCodec } from '../application/saved-page.js';
import type { ReadSavedPageMetadata } from '../../content/public.js';
import { savedPageCandidates } from './saved-page-store.js';

/** Composition supplies current account fencing and the API-instance opaque codec. */
export function savedPageUseCase(deps: {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly codec: SavedCursorCodec;
  readonly metadata: ReadSavedPageMetadata;
}) {
  return makeSavedPage({ ...deps, candidates: savedPageCandidates });
}
