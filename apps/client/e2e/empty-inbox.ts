/**
 * The Talk tab's unread dot reads the inbox on every signed-in screen, so a fixture that answers
 * `/v1/**` strictly must answer these reads too: direct conversations and content threads. These
 * smoke fixtures have neither.
 */
const DIRECT_INBOX_PATH = '/v1/social/conversations/inbox';
const THREAD_INBOX_PATH = '/v1/social/threads/inbox';

export const isInboxPath = (path: string): boolean => path === DIRECT_INBOX_PATH || path === THREAD_INBOX_PATH;

export function emptyInbox(path: string, body: Record<string, unknown>, accountId: string): Record<string, unknown> {
  return {
    version: path === THREAD_INBOX_PATH ? 'content-thread.v1' : 'direct-conversation.v1',
    readId: body['readId'],
    scope: { accountId, privacyEpoch: 1 },
    status: 'ready',
    limit: body['limit'],
    viewRevision: 1,
    items: [],
    // A thread inbox is one page of at most 50, so it has no continuation.
    ...(path === THREAD_INBOX_PATH ? {} : { continuation: { kind: 'end' } }),
  };
}
