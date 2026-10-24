import type { CheckAssetAudience } from '@knowscroll/backend/modules/content';

/** For tests that order nothing for a thread: every asset is open to everyone, as it was before Scrolls could be ordered. */
export const openToEveryone: CheckAssetAudience = (_on, _authority, assetIds) => Promise.resolve(new Set(assetIds));
