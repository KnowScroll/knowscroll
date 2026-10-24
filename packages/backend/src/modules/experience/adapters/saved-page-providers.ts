import type { FenceOwnAccount, WithPersonalScope } from '../../identity/public.js';
import { makeSavedPage, type SavedCursorCodec } from '../application/saved-page.js';
import type { CheckAssetAudience, ReadSavedPageMetadata } from '../../content/public.js';
import { gateSavedPageMetadata } from './audience-gate.js';
import { savedPageCandidates } from './saved-page-store.js';

/** Composition supplies current account fencing and the API-instance opaque codec. */
export function savedPageUseCase(deps: {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly codec: SavedCursorCodec;
  readonly metadata: ReadSavedPageMetadata;
  /** Content's audience check: a Scroll ordered for a thread shows only to those still in it. */
  readonly audience: CheckAssetAudience;
}) {
  const { audience, metadata, ...rest } = deps;
  return makeSavedPage({
    ...rest,
    metadata: gateSavedPageMetadata(metadata, audience),
    candidates: savedPageCandidates,
  });
}
