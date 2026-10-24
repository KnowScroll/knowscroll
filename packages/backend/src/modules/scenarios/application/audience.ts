import type { ReadOrderAudience } from '../../content/public.js';
import type { ReadOn } from '../../identity/public.js';
import type { BranchPoolStore } from './ports.js';

/**
 * Which of the Scrolls of branches this caller may open (D-049): those whose thread the caller takes
 * part in right now, and whose branch is not removed. A Scroll made for a thread is nobody's in Explore
 * and nobody's through a card elsewhere, so this is its only way in. A removed branch's Scroll is closed
 * to everyone. Another module's authority is never enough: it must be an account, and that account must
 * be in the thread at the time of the read. Every read goes through `on`, so a caller inside a
 * transaction never takes a second connection.
 */
export function makeReadOrderAudience(
  store: Pick<BranchPoolStore, 'holdersOfAssets'>,
  standing: (on: ReadOn, accountId: string, threadId: string) => Promise<boolean>,
): ReadOrderAudience {
  return async (on, authority, assetIds) => {
    if (authority.actor.kind !== 'account') return new Set();
    const { accountId } = authority.actor;
    const holders = await store.holdersOfAssets(on, assetIds);
    const inThread = new Map<string, Promise<boolean>>();
    const takesPart = (threadId: string) => {
      const known = inThread.get(threadId) ?? standing(on, accountId, threadId);
      inThread.set(threadId, known);
      return known;
    };
    const held = new Set<string>();
    for (const [assetId, holder] of holders)
      if (holder.status !== 'removed' && (await takesPart(holder.threadId))) held.add(assetId);
    return held;
  };
}
