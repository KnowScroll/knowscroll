import type { PersonalScopeTx } from '../../identity/public.js';
import { shownTitle, type TitleOrigin } from '../domain/titles.js';
import type { RoomLock, RoomPorts } from './ports.js';

/** What a read needs of a discussion to say what it is called. */
export interface Titled {
  readonly discussionId: string;
  readonly title: string;
  readonly titleDerived: boolean;
}

/**
 * The title each of these discussions has for this reader (`shownTitle`, D-168). A topic that was named from a message
 * is called what the message says only while the message is shown and its author is not blocked by the reader; every
 * other title is the stored one. Reads the origins and the reader's blocks only when some title is made from a message.
 */
export async function titlesFor(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  viewerAccountId: string,
  discussions: readonly Titled[],
): Promise<ReadonlyMap<string, string>> {
  const derived = discussions.filter((discussion) => discussion.titleDerived);
  const origins = await p.discussions.originsOf(
    lock,
    derived.map((discussion) => discussion.discussionId),
  );
  const authors = [
    ...new Set(
      [...origins.values()].flatMap((origin) => (origin.authorAccountId === null ? [] : [origin.authorAccountId])),
    ),
  ];
  const blocked = authors.length === 0 ? new Set<string>() : await p.blocked(scope, viewerAccountId, authors);
  const originOf = (discussionId: string): TitleOrigin | undefined => {
    const origin = origins.get(discussionId);
    return origin === undefined
      ? undefined
      : {
          shown: origin.shown,
          authorBlocked: origin.authorAccountId !== null && blocked.has(origin.authorAccountId),
        };
  };
  return new Map(discussions.map((entry) => [entry.discussionId, shownTitle(entry, originOf(entry.discussionId))]));
}
