import type { ApiClient } from './api-client';

interface FirstOpenOwner {
  readonly api: Pick<ApiClient, 'account'>;
  readonly active: boolean;
}

/**
 * Asks whether this device may play the Universe tab's first-open animation (D-114). The flag lives on
 * the account, so the answer is `play` for exactly one request in the lifetime of the account, from any
 * device, and `skip` for every other one. The claim is made as the animation starts, so a crash or a
 * closed app never plays it twice.
 *
 * A request that gets no answer is `skip`: the opening is never shown twice, and showing it late would
 * hold the tab behind a spinner. At worst a person misses it. Writes only the flag on the account; no
 * evidence, no personal data.
 */
export async function claimFirstOpen(owner: FirstOpenOwner): Promise<'play' | 'skip'> {
  if (!owner.active) return 'skip';
  try {
    const { claimed } = await owner.api.account.claimFirstOpen();
    return claimed && owner.active ? 'play' : 'skip';
  } catch {
    return 'skip';
  }
}
