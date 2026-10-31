import type { ApiClient } from './api-client';
import type { ScopedStorage } from './account-scope';

interface FirstOpenOwner {
  readonly api: Pick<ApiClient, 'account'>;
  readonly active: boolean;
  readonly storage: Pick<ScopedStorage, 'get' | 'set'>;
}

/** What the account said about the Universe tab's first-open animation. */
export type FirstOpenAnswer =
  /** This request won the account's one opening: play it. */
  | 'play'
  /** The opening has been shown (or started) before, here or on another device. */
  | 'seen'
  /** No answer came. The opening is not played, and nothing is remembered. */
  | 'unknown';

const SEEN_KEY = 'universe.first-open-seen';

/**
 * Whether this device already knows the opening is used up. It is kept in the account scope's storage, so a returning
 * account does not wait on the server at every cold start, and goes with the scope when the person signs out.
 */
export const firstOpenSeen = (owner: Pick<FirstOpenOwner, 'storage'>): boolean => owner.storage.get(SEEN_KEY) === '1';

/**
 * Asks whether this device may play the Universe tab's first-open animation (D-114). The flag lives on the account, so
 * the answer is `play` for exactly one request in the lifetime of the account, from any device, and `seen` for every
 * other one. Either answer is remembered on this device. Call it as the animation is about to start, never earlier,
 * so a crash or a closed app never plays it twice.
 *
 * A request that gets no answer is `unknown`: the opening is never shown twice, and showing it late would hold the
 * tab. At worst a person misses it. Writes only the flag on the account; no evidence, no personal data.
 */
export async function claimFirstOpen(owner: FirstOpenOwner): Promise<FirstOpenAnswer> {
  if (!owner.active) return 'unknown';
  if (firstOpenSeen(owner)) return 'seen';
  try {
    const { claimed } = await owner.api.account.claimFirstOpen();
    if (!owner.active) return 'unknown';
    owner.storage.set(SEEN_KEY, '1');
    return claimed ? 'play' : 'seen';
  } catch {
    return 'unknown';
  }
}
