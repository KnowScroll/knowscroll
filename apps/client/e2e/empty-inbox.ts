/**
 * The Talk tab's unread dot reads the inbox on every signed-in screen, so a fixture that answers
 * `/v1/**` strictly must answer this read too. These smoke fixtures have no conversations.
 */
export const INBOX_PATH = '/v1/social/conversations/inbox';

export function emptyInbox(body: Record<string, unknown>, accountId: string): Record<string, unknown> {
  return {
    version: 'direct-conversation.v1',
    readId: body['readId'],
    scope: { accountId, privacyEpoch: 1 },
    status: 'ready',
    limit: body['limit'],
    viewRevision: 1,
    items: [],
    continuation: { kind: 'end' },
  };
}
