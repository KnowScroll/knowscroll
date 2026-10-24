import type { AccountScope } from './account-scope';

/**
 * What a person has blocked changes what other screens show (a room collapses a blocked person's words for
 * the blocker, D-051), and no message tells a screen that already holds the old picture. A block or unblock
 * that the server accepted bumps a counter in the scope's query cache; a screen that cares watches it and
 * reads afresh. It lives and dies with the scope, so it can never carry a block across accounts.
 */
const BLOCKS_KEY = 'blocks-revision';

/** The query key a screen watches. */
export const blocksRevisionKey = (scope: AccountScope): readonly (string | number)[] => scope.queryKey(BLOCKS_KEY);

/** Says that a block or unblock was accepted. */
export function announceBlocksChanged(scope: AccountScope): void {
  scope.queryClient.setQueryData<number>(blocksRevisionKey(scope), (revision) => (revision ?? 0) + 1);
}
