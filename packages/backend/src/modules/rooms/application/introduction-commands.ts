import { IntroduceResidentSchema, ResidentIntroducedAcceptanceSchema } from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { nameOf } from '../domain/cast.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { RESIDENT_CHARACTERS, introductionTitle } from '../domain/residents.js';
import { receiptBase, runCommand } from './command.js';
import { hasResident, ok, refuse, type Result, type RoomPorts } from './ports.js';

/**
 * A resident's introduction (v3 R-8b, D-275). A moderator has one of the room's residents say who it is, once: a post in the Feed
 * whose words are the product's own text for that resident (`RESIDENT_CHARACTERS`), never a model's, so no call is made and no cap
 * is spent. It is the resident's own post, labelled AI like every other, with the moderator only as its starter (cleared with their
 * account); the room's members reply and vote under it like under any post. There is one per resident per room: asking again is
 * accepted and says `already_introduced`. Refused for a member who is not a moderator, a resident the room does not have, and a room
 * that is not open. An introduction is conversation: it writes nothing to a person's universe.
 */
export function makeIntroductionCommands(p: RoomPorts) {
  return {
    introduceResident(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ResidentIntroducedAcceptanceSchema>>> {
      const parsed = IntroduceResidentSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.resident-introduce',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: ResidentIntroducedAcceptanceSchema,
        requires: 'moderator',
        mode: 'write',
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status) || !hasResident(standing.room, command.inhabitant))
            return refuse('unavailable');
          const accepted = (discussionId: string, result: 'introduced' | 'already_introduced') =>
            ResidentIntroducedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.resident-introduce',
              roomId: command.roomId,
              discussionId,
              result,
            });
          const existing = await p.posts.introductionOf(lock, command.inhabitant);
          if (existing !== undefined) return ok(() => Promise.resolve(accepted(existing, 'already_introduced')));
          const name = nameOf(standing.room.cast, command.inhabitant);
          return ok(async () => {
            const discussionId = p.newId();
            await p.discussions.create(lock, {
              discussionId,
              title: introductionTitle(name),
              titleDerived: false,
              tag: undefined,
              root: undefined,
              originMessageId: undefined,
              startedByAccountId: owner.accountId,
              intro: { inhabitant: command.inhabitant },
              now,
            });
            await p.discussions.append(lock, discussionId, {
              kind: 'ai',
              messageId: p.newId(),
              inhabitant: command.inhabitant,
              aiKind: 'explanation',
              text: RESIDENT_CHARACTERS[command.inhabitant].introduction(name),
              recordedAt: now,
            });
            await p.rooms.announce(lock, now);
            return accepted(discussionId, 'introduced');
          });
        },
      });
    },
  };
}
