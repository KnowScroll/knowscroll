import type { DirectConversationRef, DirectConversationSummary } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';

const VERSION = 'direct-conversation.v1' as const;
const PAGE = 30;

export interface InboxPage {
  readonly items: readonly DirectConversationSummary[];
  /** The cursor of the next page; none on the last. */
  readonly next: string | undefined;
}

/**
 * One page of the Talk inbox, newest activity first. `restart` means the server calls the cursor
 * stale: begin again from the first page. A failed request throws; `talkFailure` classifies it.
 */
export async function readInboxPage(
  scope: AccountScope,
  newId: () => string,
  cursor?: string,
): Promise<InboxPage | 'restart'> {
  const page = await scope.api.conversations.inbox({
    version: VERSION,
    readId: newId(),
    limit: PAGE,
    ...(cursor === undefined ? {} : { cursor }),
  });
  if (page.status === 'refresh_required') return 'restart';
  return { items: page.items, next: page.continuation.kind === 'more' ? page.continuation.cursor : undefined };
}

/**
 * Finds the person's own reference to a conversation they know only by its ID (a link into Talk).
 * Looks through the inbox; `undefined` when it is not there, which a screen shows as unavailable.
 */
export async function findConversation(
  scope: AccountScope,
  newId: () => string,
  conversationId: string,
): Promise<DirectConversationRef | undefined> {
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const page = await readInboxPage(scope, newId, cursor);
    if (page === 'restart') return findConversation(scope, newId, conversationId);
    const found = page.items.find((item) => item.conversation.conversationId === conversationId);
    if (found) return found.conversation;
    if (page.next === undefined) return undefined;
    cursor = page.next;
  }
  return undefined;
}

/**
 * Blocks a friend from a conversation: reads the current friendship view, then blocks with it.
 * Returns whether the block was accepted. Blocking closes the conversation for both people and
 * tells the other person nothing.
 */
export async function blockFriend(scope: AccountScope, newId: () => string, personId: string): Promise<boolean> {
  try {
    const pair = await scope.api.sharing.pair({ version: 'sharing.v1', peerPersonId: personId });
    if (pair.status !== 'available') return false;
    await scope.api.sharing.block({
      version: 'sharing.v1',
      commandId: newId(),
      peerPersonId: personId,
      expectedPairRevision: pair.pair.pairRevision,
    });
    return true;
  } catch {
    return false;
  }
}
