import {
  PostRoomFindSchema,
  RoomFindPostedAcceptanceSchema,
  RoomPostVoteAcceptanceSchema,
  VoteRoomPostSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { dayStartOf } from '../domain/feed.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { POST_RULES, checkSource, mayPost, postTextProblem } from '../domain/posts.js';
import { scheduleCastCheck } from './cast-schedule.js';
import { receiptBase, runCommand } from './command.js';
import { ok, refuse, type ContentRef, type Result, type RoomPorts } from './ports.js';

type PostLink =
  { readonly kind: 'content'; readonly root: ContentRef } | { readonly kind: 'source'; readonly url: string };

/**
 * A member's post to the Feed, and the votes on every post (v3 R-8b, D-271 to D-273). Both run in the caller's personal scope and the
 * room's lock, need a current member of a room that is open, and commit their effect and receipt together. Neither calls a model, and
 * neither is consumption evidence: a post and a vote are conversation, and nothing here writes to a person's universe.
 */
export function makePostCommands(p: RoomPorts) {
  /** The link a post may carry: the current admitted revision of a library asset, or a source that passed its checks. */
  async function resolveLink(
    scope: PersonalScopeTx,
    link: z.infer<typeof PostRoomFindSchema>['link'],
  ): Promise<Result<PostLink>> {
    if (link.kind === 'source') {
      const checked = checkSource(link.url);
      return checked.kind === 'ok' ? ok({ kind: 'source', url: checked.source.url }) : refuse('invalid_input');
    }
    const [card] = await p.readContent(scope, [link.target]);
    return card?.status === 'available' ? ok({ kind: 'content', root: link.target }) : refuse('unavailable');
  }

  return {
    /**
     * Posts a find to the room's Feed: the member's headline and words, and one link, a library Reel or Scroll or a source. The
     * words are theirs and no model is called. The room is locked for the write so the day's cap and the one-post-per-link rule are
     * exact. When the room already has a post about that asset or source nothing is made and the answer names it
     * (`already_there`). Refused: not a member, a paused or closed room, a headline or words that fail their rules (empty, too long,
     * an address in them), an address that is not a plain source, an asset that is not served, and a fourth post in a UTC day
     * (`rate_limited`). The same command again is accepted.
     */
    postFind(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomFindPostedAcceptanceSchema>>> {
      const parsed = PostRoomFindSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.find-post',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomFindPostedAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          if (
            postTextProblem(command.title, POST_RULES.titleMaxChars, false) !== undefined ||
            postTextProblem(command.words, POST_RULES.wordsMaxChars, true) !== undefined
          )
            return refuse('invalid_input');
          const link = await resolveLink(scope, command.link);
          if (link.kind === 'refused') return link;
          const existing = await p.posts.existing(
            lock,
            link.value.kind === 'content'
              ? { kind: 'content', assetId: link.value.root.assetId }
              : { kind: 'source', url: link.value.url },
          );
          const accepted = (discussionId: string, result: 'posted' | 'already_there') =>
            RoomFindPostedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.find-post',
              roomId: command.roomId,
              discussionId,
              result,
            });
          if (existing !== undefined) return ok(() => Promise.resolve(accepted(existing, 'already_there')));
          if (!mayPost(await p.posts.postsSince(lock, owner.accountId, dayStartOf(now)))) return refuse('rate_limited');
          return ok(async () => {
            const discussionId = p.newId();
            await p.discussions.create(lock, {
              discussionId,
              title: command.title,
              titleDerived: false,
              tag: undefined,
              root: link.value.kind === 'content' ? link.value.root : undefined,
              originMessageId: undefined,
              startedByAccountId: owner.accountId,
              post: { sourceUrl: link.value.kind === 'source' ? link.value.url : undefined },
              now,
            });
            const messageId = p.newId();
            await p.discussions.append(lock, discussionId, {
              kind: 'person',
              messageId,
              commandId: command.commandId,
              authorAccountId: owner.accountId,
              recordedAt: now,
              text: command.words,
            });
            // The post's words may be a question or a strong claim, like any message: the room's router decides, later and within its
            // caps and ledger, whether a resident answers or corrects (D-278). Nothing is called here.
            await scheduleCastCheck(p, scope, lock, {
              room: standing.room,
              discussionId,
              messageId,
              authorAccountId: owner.accountId,
              text: command.words,
              now,
            });
            await p.rooms.announce(lock, now);
            return accepted(discussionId, 'posted');
          });
        },
      });
    },

    /**
     * Votes up on a post, or takes the vote back. One vote per member per post and up only. Refused for the member's own post
     * (`invalid_input`), for a post that is not there, is not shown or whose author the member blocked, and in a room that is not
     * open. Residents and scouts have no account, so they cannot vote at all. The same value again changes nothing. The answer
     * carries the post's votes as a number, never who.
     */
    votePost(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomPostVoteAcceptanceSchema>>> {
      const parsed = VoteRoomPostSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.post-vote',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomPostVoteAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const post = await p.posts.votable(lock, command.discussionId);
          if (post === undefined) return refuse('unavailable');
          if (post.authorAccountId === owner.accountId) return refuse('invalid_input');
          if (
            post.authorAccountId !== null &&
            (await p.blocked(scope, owner.accountId, [post.authorAccountId])).has(post.authorAccountId)
          )
            return refuse('unavailable');
          return ok(async () => {
            await p.posts.setVote(lock, command.discussionId, owner.accountId, command.voted, now);
            return RoomPostVoteAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.post-vote',
              roomId: command.roomId,
              discussionId: command.discussionId,
              voted: command.voted,
              votes: await p.posts.votesOf(lock, command.discussionId),
            });
          });
        },
      });
    },
  };
}
