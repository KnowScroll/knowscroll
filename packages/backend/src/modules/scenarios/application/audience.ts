import type { ReadOrderAudience } from '../../content/public.js';
import type { BranchPoolStore } from './ports.js';

/**
 * Who may open the Scroll of a branch (D-049): the members who take part in its thread right now. A
 * Scroll made for a thread is nobody's in Explore and nobody's through a card elsewhere, so this is
 * its only way in. A removed branch's Scroll is closed to everyone. Another module's authority is
 * never enough: it must be an account, and that account must be in the thread at the time of the read.
 */
export function makeReadOrderAudience(
  store: Pick<BranchPoolStore, 'holderOfAsset'>,
  standing: (accountId: string, threadId: string) => Promise<boolean>,
): ReadOrderAudience {
  return async (authority, assetId) => {
    if (authority.actor.kind !== 'account') return false;
    const holder = await store.holderOfAsset(assetId);
    return holder !== undefined && holder.status !== 'removed' && standing(authority.actor.accountId, holder.threadId);
  };
}
