import {
  ActivityCreationSchema,
  ActivityListSchema,
  ActivityModerationAcceptanceSchema,
  ActivityViewSchema,
  CreateActivitySchema,
  ModerateActivitySchema,
  PollVoteAcceptanceSchema,
  ReadActivitiesSchema,
  ReadActivitySchema,
  VotePollSchema,
  type PublicPersonRef,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import {
  MAX_LISTED,
  MAX_OPEN_ACTIVITIES,
  MAX_STARTED_PER_DAY,
  VOTERS_SHOWN,
  acceptsNewActivity,
  acceptsVotes,
  definitionOf,
  titleOf,
} from '../domain/activities.js';
import { utcDayStart } from '../domain/contribution.js';
import { isModerator } from '../domain/membership.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type ActivityRow, type Result, type RoomPorts } from './ports.js';

/**
 * Optional room activity (R03): a moderator's poll or quiz, only inside the room, never in a feed, never
 * required, never scored and never an input to a universe. A poll's votes are visible to the room and can
 * be changed until it closes. A quiz is served whole and answered on the device: no answer, score or
 * position reaches the server, so there is nothing here to rank, resume or remember. Nothing in this
 * file is consumption evidence for anyone, and an AI inhabitant has no way to start an activity.
 */
export function makeActivities(p: RoomPorts) {
  /** The view of one activity for a member of the room. */
  async function viewOf(
    scope: Parameters<RoomPorts['people']['byAccounts']>[0],
    entered: NonNullable<Awaited<ReturnType<typeof enterRoom>>>,
    row: ActivityRow,
    readId: string,
  ) {
    const { lock, owner, standing, member } = entered;
    const { room } = standing;
    const base = {
      ...roomEnvelope(scope),
      readId,
      status: 'ready' as const,
      roomId: room.roomId,
      activityId: row.activityId,
      state: row.state === 'open' ? ('open' as const) : ('closed' as const),
      startedAt: row.createdAt.toISOString(),
      canModerate: member !== undefined && isModerator(member.role),
    };
    const definition = row.definition;
    if (definition.kind === 'quiz')
      return ActivityViewSchema.parse({
        ...base,
        activity: {
          kind: 'quiz',
          title: definition.title,
          questions: definition.questions.map((question) => ({
            questionId: question.id,
            prompt: question.prompt,
            options: question.options.map((option) => ({ optionId: option.id, text: option.text })),
            explanation: question.explanation,
          })),
        },
      });
    const yourVote = await p.activities.yourVote(lock, row.activityId, owner.accountId);
    // Results are shown once the person has voted or the poll is closed, and not before: a tally is never
    // sent to someone who has not chosen yet, whatever their client does with it.
    const resultsVisible = row.state !== 'open' || yourVote !== undefined;
    const tally = resultsVisible ? await p.activities.tally(lock, row.activityId, VOTERS_SHOWN) : [];
    const voterIds = [...new Set(tally.flatMap((entry) => entry.voterAccountIds))];
    const people: ReadonlyMap<string, PublicPersonRef> =
      voterIds.length === 0 ? new Map() : await p.people.byAccounts(scope, voterIds);
    return ActivityViewSchema.parse({
      ...base,
      activity: {
        kind: 'poll',
        prompt: definition.prompt,
        resultsVisible,
        options: definition.options.map((option) => {
          if (!resultsVisible) return { optionId: option.id, text: option.text };
          const votes = tally.find((entry) => entry.optionId === option.id);
          return {
            optionId: option.id,
            text: option.text,
            votes: votes?.votes ?? 0,
            voters: (votes?.voterAccountIds ?? []).flatMap((id) => {
              const person = people.get(id);
              return person === undefined ? [] : [person];
            }),
          };
        }),
        ...(yourVote === undefined ? {} : { yourVote }),
        canVote: member !== undefined && acceptsVotes(room.status, row.state),
      },
    });
  }

  return {
    /** The room's activities, for a member. Anyone else gets the one `unavailable` shape. */
    async activities(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ActivityListSchema>>> {
      const parsed = ReadActivitiesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...roomEnvelope(scope), readId: query.readId };
        const entered = await enterRoom(p, scope, query.roomId, 'read');
        if (!entered || entered.member === undefined)
          return ok(ActivityListSchema.parse({ ...envelope, status: 'unavailable' }));
        const rows = await p.activities.list(entered.lock, entered.owner.accountId, MAX_LISTED);
        return ok(
          ActivityListSchema.parse({
            ...envelope,
            status: 'ready',
            roomId: query.roomId,
            canCreate: isModerator(entered.member.role) && acceptsNewActivity(entered.standing.room.status),
            activities: rows.map(({ row, voted }) => ({
              activityId: row.activityId,
              kind: row.kind,
              title: row.title,
              state: row.state === 'open' ? 'open' : 'closed',
              startedAt: row.createdAt.toISOString(),
              ...(row.kind === 'poll' ? { voted } : {}),
            })),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** One activity, for a member. A removed or unknown one is `unavailable`. */
    async readActivity(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ActivityViewSchema>>> {
      const parsed = ReadActivitySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...roomEnvelope(scope), readId: query.readId };
        const entered = await enterRoom(p, scope, query.roomId, 'read');
        const gone = ok(ActivityViewSchema.parse({ ...envelope, status: 'unavailable' }));
        if (!entered || entered.member === undefined) return gone;
        const row = await p.activities.load(entered.lock, query.activityId, 'none');
        if (row === undefined || row.state === 'removed') return gone;
        return ok(await viewOf(scope, entered, row, query.readId));
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /** A moderator starts a poll or quiz in a room that is open. Bounded per room: five open at once, twenty a day. */
    createActivity(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ActivityCreationSchema>>> {
      const parsed = CreateActivitySchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.activity-create',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: ActivityCreationSchema,
        requires: 'moderator',
        // FOR UPDATE: the open and daily bounds are counted under this lock, so concurrent moderators cannot exceed them.
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!acceptsNewActivity(standing.room.status)) return refuse('unavailable');
          const [open, today] = await Promise.all([
            p.activities.openCount(lock),
            p.activities.startedSince(lock, utcDayStart(now)),
          ]);
          if (open >= MAX_OPEN_ACTIVITIES || today >= MAX_STARTED_PER_DAY) return refuse('rate_limited');
          const definition = definitionOf(command.activity);
          return ok(async () => {
            const activityId = p.newId();
            await p.activities.create(lock, {
              activityId,
              kind: definition.kind,
              title: titleOf(definition),
              definition,
              createdByAccountId: owner.accountId,
              now,
            });
            return ActivityCreationSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'activity.create',
              roomId: command.roomId,
              activityId,
            });
          });
        },
      });
    },

    /**
     * A member's vote in an open poll of an open room. The vote replaces their earlier one, so a new
     * command ID is a change of mind; a retry with the same ID is the same vote.
     */
    votePoll(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof PollVoteAcceptanceSchema>>> {
      const parsed = VotePollSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.poll-vote',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: PollVoteAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          // A vote takes the activity row FOR SHARE: a close that commits first is seen, so no vote lands after it.
          const row = await p.activities.load(lock, command.activityId, 'share');
          if (row === undefined || row.definition.kind !== 'poll' || !acceptsVotes(standing.room.status, row.state))
            return refuse('unavailable');
          if (!row.definition.options.some((option) => option.id === command.optionId)) return refuse('invalid_input');
          return ok(async () => {
            await p.activities.vote(lock, command.activityId, owner.accountId, command.optionId, now);
            return PollVoteAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'poll.vote',
              roomId: command.roomId,
              activityId: command.activityId,
              optionId: command.optionId,
            });
          });
        },
      });
    },

    /** A moderator closes a poll (votes stay and are shown) or removes an activity (never served again). */
    moderateActivity(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ActivityModerationAcceptanceSchema>>> {
      const parsed = ModerateActivitySchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.activity-moderate',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: ActivityModerationAcceptanceSchema,
        requires: 'moderator',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock } = entered;
          const row = await p.activities.load(lock, command.activityId, 'update');
          if (row === undefined || row.state === 'removed') return refuse('unavailable');
          return ok(async () => {
            // Closing a closed activity is already what was asked; nothing is rewritten.
            if (command.action === 'remove') await p.activities.setState(lock, command.activityId, 'removed', now);
            else if (row.state === 'open') await p.activities.setState(lock, command.activityId, 'closed', now);
            return ActivityModerationAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'activity.moderate',
              roomId: command.roomId,
              activityId: command.activityId,
              action: command.action,
            });
          });
        },
      });
    },
  };
}
