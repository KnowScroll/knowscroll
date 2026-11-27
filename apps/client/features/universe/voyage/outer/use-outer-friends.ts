import { useCallback, useEffect, useState } from 'react';
import { createFriendsSession, type AccountScope, type FriendsSession } from '@knowscroll/client-core';
import { newCommandId } from '../../../../platform/command-id';
import type { OuterStatus } from './outer-copy';
import { orderFriends, type OuterFriend } from './friend-order';
import { readAllFriends, type FriendsPager } from './read-friends';

/** What the outer stop knows of the friends. */
export interface OuterFriends {
  readonly status: OuterStatus;
  /** In the order they take their places. While the read is still going, the ones read so far are not shown: it is all or the partial of a stopped read. */
  readonly friends: readonly OuterFriend[];
  /** False for a roster longer than the read goes on for, or a read that stopped: the list is not all of them. */
  readonly complete: boolean;
  /** Read again from page one (only after a failure). */
  readonly retry: () => void;
}

const NONE: readonly OuterFriend[] = [];

interface Answer {
  readonly scope: AccountScope;
  readonly attempt: number;
  readonly status: 'ready' | 'offline' | 'failed';
  readonly friends: readonly OuterFriend[];
  readonly complete: boolean;
}

/** The session a read is made through: the Friends session, private to this read. A test hands in a smaller one. */
type MakeSession = (scope: AccountScope) => FriendsSession | (FriendsPager & { dispose(): void });
const makeFriendsSession: MakeSession = (scope) => createFriendsSession({ scope, newCommandId });

/**
 * One paged read of the friends roster, started when `active` turns true and dropped when it turns false (the session is
 * disposed and the friends forgotten). No request kind is new: it is the Friends list's own read, `friend-pages.v2`.
 * Without an account (`scope` undefined or ended) nothing is read and the status stays `idle`.
 *
 * `makeSession` is a dependency of the read's effect, so it must be a stable function (the default is): an inline one that
 * changes on every render would read again, forever.
 */
export function useOuterFriends(
  scope: AccountScope | undefined,
  active: boolean,
  makeSession: MakeSession = makeFriendsSession,
): OuterFriends {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | undefined>(undefined);
  useEffect(() => {
    if (!active || scope === undefined || !scope.active) return undefined;
    let wanted = true;
    let session: ReturnType<MakeSession> | undefined;
    void (async () => {
      let read: Awaited<ReturnType<typeof readAllFriends>>;
      try {
        session = makeSession(scope);
        read = await readAllFriends(session, { wanted: () => wanted && scope.active });
      } catch {
        read = { status: 'failed', friends: NONE, complete: false };
      }
      if (wanted)
        setAnswer({
          scope,
          attempt,
          status: read.status,
          friends: orderFriends(read.friends),
          complete: read.complete,
        });
    })();
    return () => {
      wanted = false;
      session?.dispose();
      setAnswer(undefined);
    };
  }, [active, scope, attempt, makeSession]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  if (!active || scope === undefined || !scope.active) return { status: 'idle', friends: NONE, complete: false, retry };
  if (answer === undefined || answer.scope !== scope || answer.attempt !== attempt)
    return { status: 'loading', friends: NONE, complete: false, retry };
  return { status: answer.status, friends: answer.friends, complete: answer.complete, retry };
}
