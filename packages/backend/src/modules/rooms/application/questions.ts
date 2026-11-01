import {
  LeaveQuestionSchema,
  QUESTION_REPLIES_MAX,
  QuestionLeftAcceptanceSchema,
  QuestionNoticeAcceptanceSchema,
  SetQuestionNoticeSchema,
  type PublicPersonRef,
  type QuestionReply,
  type RoomQuestions,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { titleFrom } from '../domain/titles.js';
import { askDecisionFor, queueAsk } from './ask-turn.js';
import { receiptBase, runCommand } from './command.js';
import { titlesFor } from './discussion-titles.js';
import type { EnteredRoom } from './gate.js';
import { hasResident, ok, refuse, type Result, type RoomPorts } from './ports.js';

/** The title of a question that has no words left to name it. */
const QUESTION_FALLBACK_TITLE = 'A question';

/**
 * What a member's view of the room says of questions (R3 F, D-242): how many are waiting for a person, and which of the caller's own
 * a person has answered since they last looked. The answer is the first shown message of a person other than the asker whom the asker
 * has not blocked; a resident's words never count, so a question a resident answered is still open and its asker is not told. Read
 * from the messages, so an answer that a moderator removes, or whose author deletes their account, takes its notice with it.
 */
export async function questionsView(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom,
): Promise<RoomQuestions | undefined> {
  const { lock, owner } = entered;
  const [waiting, unnoticed] = await Promise.all([
    p.questions.waiting(lock),
    p.questions.unnoticed(lock, owner.accountId, QUESTION_REPLIES_MAX),
  ]);
  const candidates = [
    ...new Set(unnoticed.flatMap((question) => question.answerers.map((answer) => answer.accountId))),
  ];
  const [blocked, people] =
    candidates.length === 0
      ? [new Set<string>(), new Map<string, PublicPersonRef>()]
      : await Promise.all([p.blocked(scope, owner.accountId, candidates), p.people.byAccounts(scope, candidates)]);
  // The title is the asker's first words, so it is read through the same protections as any title made from a message (D-168).
  const titles = await titlesFor(p, scope, lock, owner.accountId, unnoticed);
  const replies = unnoticed.flatMap((question): QuestionReply[] => {
    const first = question.answerers.find((answer) => !blocked.has(answer.accountId) && people.has(answer.accountId));
    return first === undefined
      ? []
      : [
          {
            discussionId: question.discussionId,
            title: titles.get(question.discussionId)!,
            by: people.get(first.accountId)!,
            askedAt: question.askedAt.toISOString(),
            at: first.recordedAt.toISOString(),
          },
        ];
  });
  return waiting === 0 && replies.length === 0 ? undefined : { waiting, replies };
}

/**
 * A question left for people (R3 F, D-242). `leaveQuestion` is one command and one transaction: a topic tagged Question that begins with
 * the member's words, a card for it in General where the room will see it, and, when the member asked for it, a resident's answer as an
 * asked turn within the usual bounds (D-167). Nothing here starts the unprompted router, so no resident answers a question its asker did
 * not ask them to; an idle room still makes no call. A question is open while no person but its asker has spoken in it, and is read
 * from the messages. `questionNotice` is the asker's own switch and acknowledgement. Neither is evidence for anyone.
 */
export function makeQuestions(p: RoomPorts) {
  return {
    /**
     * Leaves a question for the next person. The room is locked FOR UPDATE because the asked-turn bounds are counts. When the asker
     * asks a resident now and the bounds are full, the question is still left and the answer says `resting`; when they keep their
     * messages out of what AI reads, no resident reads the words and the answer says `kept_out`. The same command again replays.
     */
    leaveQuestion(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof QuestionLeftAcceptanceSchema>>> {
      const parsed = LeaveQuestionSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.question-leave',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: QuestionLeftAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        async decide({ scope, entered, member, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const general = await p.discussions.general(lock);
          if (general === undefined) return refuse('unavailable');
          const discussionId = p.newId();
          const decision = command.askNow
            ? await askDecisionFor(p, lock, owner.accountId, discussionId, now)
            : undefined;
          const asked = !command.askNow
            ? 'not_asked'
            : member?.keepOut === true
              ? 'kept_out'
              : decision === 'allowed' && hasResident(standing.room, 'explainer')
                ? 'queued'
                : 'resting';
          return ok(async () => {
            const messageId = p.newId();
            await p.discussions.create(lock, {
              discussionId,
              title: titleFrom(command.text, QUESTION_FALLBACK_TITLE),
              titleDerived: false,
              tag: 'question',
              root: undefined,
              originMessageId: undefined,
              startedByAccountId: owner.accountId,
              notifyAnswer: command.notify,
              now,
            });
            await p.discussions.append(lock, discussionId, {
              kind: 'person',
              messageId,
              commandId: command.commandId,
              authorAccountId: owner.accountId,
              recordedAt: now,
              text: command.text,
            });
            // The title is the first words of that message, so it is the asker's words with the protections of any such title: it is
            // read only while the message is shown and not blocked by the reader, and it becomes the neutral title when its author's
            // account is deleted (D-168). The message exists now, so it can be the origin.
            await p.discussions.setOrigin(lock, discussionId, messageId);
            // The card where the room talks: the question is findable from General, and keeps up as people answer.
            await p.discussions.append(lock, general.discussionId, {
              kind: 'person',
              messageId: p.newId(),
              commandId: p.newId(),
              authorAccountId: owner.accountId,
              recordedAt: now,
              topicDiscussionId: discussionId,
            });
            if (asked === 'queued')
              await queueAsk(p, scope, lock, {
                kind: 'about',
                inhabitant: 'explainer',
                roomId: command.roomId,
                discussionId,
                causeMessageId: messageId,
                accountId: owner.accountId,
                commandId: command.commandId,
                now,
              });
            await p.rooms.announce(lock, now);
            return QuestionLeftAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'question.leave',
              roomId: command.roomId,
              discussionId,
              asked,
            });
          });
        },
      });
    },

    /**
     * Sets whether the asker is told when a person answers, and/or records that they noticed an answer (so its notice is not shown
     * again). Only the person who left the question may, and anything else is the same `unavailable`. Taking the switch off and
     * putting it back does not bring back a notice that was already noticed.
     */
    questionNotice(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof QuestionNoticeAcceptanceSchema>>> {
      const parsed = SetQuestionNoticeSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.question-notice',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: QuestionNoticeAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner } = entered;
          const question = await p.discussions.load(lock, command.discussionId);
          if (question?.tag !== 'question' || question.startedByAccountId !== owner.accountId)
            return refuse('unavailable');
          return ok(async () => {
            const set = await p.questions.setNotice(lock, {
              discussionId: command.discussionId,
              accountId: owner.accountId,
              ...(command.notify === undefined ? {} : { notify: command.notify }),
              ...(command.noticed === true ? { noticedAt: now } : {}),
            });
            // The question was read under the room's lock a moment ago and nothing deletes a discussion, so it is there.
            if (set === undefined) throw new Error('ROOMS_QUESTION_MISSING');
            return QuestionNoticeAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'question.notice',
              roomId: command.roomId,
              discussionId: command.discussionId,
              notify: set.notify,
            });
          });
        },
      });
    },
  };
}
