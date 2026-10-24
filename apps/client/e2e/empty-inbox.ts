/**
 * The Talk tab's unread dot reads the inbox on every signed-in screen, so a fixture that answers
 * `/v1/**` strictly must answer these reads too: direct conversations, content threads and rooms. The
 * Universe also asks for the room stations beside its systems. These smoke fixtures have none of them.
 */
const DIRECT_INBOX_PATH = '/v1/social/conversations/inbox';
const THREAD_INBOX_PATH = '/v1/social/threads/inbox';
const ROOM_LIST_PATH = '/v1/rooms/list';
const ROOM_STATIONS_PATH = '/v1/rooms/stations';

export const isInboxPath = (path: string): boolean =>
  path === DIRECT_INBOX_PATH || path === THREAD_INBOX_PATH || path === ROOM_LIST_PATH || path === ROOM_STATIONS_PATH;

export function emptyInbox(path: string, body: Record<string, unknown>, accountId: string): Record<string, unknown> {
  if (path === ROOM_LIST_PATH || path === ROOM_STATIONS_PATH)
    return {
      version: 'rooms.v1',
      readId: body['readId'],
      scope: { accountId, privacyEpoch: 1 },
      status: 'ready',
      ...(path === ROOM_LIST_PATH ? { items: [] } : { stations: [] }),
    };
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
