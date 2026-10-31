import { DebateVoteAcceptanceSchema, VoteDebateSchema, type RoomDebate } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { isClosedAt, resultOf } from '../domain/debate.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { receiptBase, runCommand } from './command.js';
import { ok, refuse, type Result, type RoomLock, type RoomPorts } from './ports.js';

/**
 * A debate as the reader sees it (R3 B and E): its two sides, when it closes, the reader's own vote, and the tally only to
 * someone who voted or once it closed (as a poll's, so a vote is a choice and not a bandwagon). A debate past its close time
 * reads as closed even before the first member command after it settles the star.
 */
export async function debateViewOf(
  p: RoomPorts,
  lock: RoomLock,
  discussionId: string,
  accountId: string,
  now: Date,
): Promise<RoomDebate | undefined> {
  const debate = await p.debates.load(lock, discussionId, 'none');
  if (debate === undefined) return undefined;
  const closed = debate.state === 'closed' || isClosedAt(debate.closesAt, now);
  const yourVote = await p.debates.yourVote(lock, discussionId, accountId);
  const tally = closed || yourVote !== undefined ? await p.debates.tally(lock, discussionId) : undefined;
  return {
    sides: [
      { text: debate.sides[0], ...(tally === undefined ? {} : { votes: tally.a }) },
      { text: debate.sides[1], ...(tally === undefined ? {} : { votes: tally.b }) },
    ],
    closesAt: debate.closesAt.toISOString(),
    state: closed ? 'closed' : 'open',
    ...(yourVote === undefined ? {} : { yourVote }),
    ...(closed && tally !== undefined
      ? (() => {
          const { winner } = resultOf(tally);
          return winner === undefined ? {} : { winner };
        })()
      : {}),
  };
}

/** A member's vote on a debate's side. */
export function makeDebateVotes(p: RoomPorts) {
  return {
    /**
     * Votes on a debate, or changes the vote, until the debate closes. The debate's row is held FOR SHARE, so a vote either
     * lands before a close decides or is refused after it. The same vote again is accepted; a vote on a debate that has
     * closed, in a room that is not open, or on a discussion that is not a debate is `unavailable`. Only counts are ever
     * shown, never who chose what, and a vote is conversation, not evidence for anyone.
     */
    voteDebate(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof DebateVoteAcceptanceSchema>>> {
      const parsed = VoteDebateSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.debate-vote',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: DebateVoteAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const debate = await p.debates.load(lock, command.discussionId, 'share');
          if (debate === undefined || debate.state === 'closed' || isClosedAt(debate.closesAt, now))
            return refuse('unavailable');
          return ok(async () => {
            await p.debates.setVote(lock, command.discussionId, owner.accountId, command.side, now);
            return DebateVoteAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'debate.vote',
              roomId: command.roomId,
              discussionId: command.discussionId,
              side: command.side,
            });
          });
        },
      });
    },
  };
}
