import {
  ChooseRoomFlairSchema,
  ReadRoomFlairSchema,
  RoomFlairChosenAcceptanceSchema,
  RoomFlairViewSchema,
  type RoomFlairKind,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { comingFlair, earnedFlair, mayChoose, shownFlair, type FlairChoice } from '../domain/flair.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import { ok, refuse, roomEnvelope, type Result, type RoomLock, type RoomPorts } from './ports.js';

/**
 * The flair each of these people shows beside their name to this reader (R3 E5, D-341 to D-343): only a current member who has
 * earned a mark and has not hidden it, and not someone the reader blocked or who blocked the reader, whose absence says nothing
 * because flair is optional, hideable and often unearned. Counts the acts of the authors of one page, never more than a mark needs.
 * Only person authors are asked about, so an AI inhabitant or a scout never reaches here.
 */
export async function flairShownTo(
  p: RoomPorts,
  scope: PersonalScopeTx,
  lock: RoomLock,
  viewerAccountId: string,
  authorAccountIds: readonly string[],
): Promise<ReadonlyMap<string, RoomFlairKind>> {
  const others = authorAccountIds.filter((accountId) => accountId !== viewerAccountId);
  if (others.length === 0) return new Map();
  const masked = await p.blocked(scope, viewerAccountId, others, 'either');
  const visible = others.filter((accountId) => !masked.has(accountId));
  const members = await p.flair.membersOf(lock, visible, { shownOnly: true });
  return new Map(
    members.flatMap((member) => {
      const shown = shownFlair(member.choice, earnedFlair(member.acts));
      return shown === undefined ? [] : [[member.accountId, shown] as const];
    }),
  );
}

/** What a person's choice says in the contract: the stored `null` is `auto`, which the command names and the view leaves out. */
const storedChoice = (flair: 'auto' | NonNullable<FlairChoice>): FlairChoice => (flair === 'auto' ? null : flair);

/** A member's own flair card, and their choice of what shows beside their name. Members only; neither is evidence for anyone. */
export function makeFlairUseCases(p: RoomPorts) {
  return {
    /**
     * A member reads their own flair for the room: what they have earned, what they are partway to, their choice and what
     * others see now (R3 E5). Reads only this person's own acts in this room, writes nothing, and says nothing of anyone else.
     * Every refusal is `unavailable`.
     */
    async flair(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomFlairViewSchema>>> {
      const parsed = ReadRoomFlairSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope) => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const [own] = await p.flair.membersOf(entered.lock, [entered.owner.accountId], { shownOnly: false });
        if (own === undefined) return refuse('unavailable');
        const earned = earnedFlair(own.acts);
        const shown = shownFlair(own.choice, earned);
        return ok(
          RoomFlairViewSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            earned,
            coming: comingFlair(own.acts),
            ...(own.choice === null ? {} : { choice: own.choice }),
            ...(shown === undefined ? {} : { shown }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * A member chooses what shows beside their name: a mark they have earned, `none` to hide it, or `auto` for the first they
     * have earned. The same choice again is accepted, so a retry and a second tap end in the same state. A mark they have not
     * earned is refused (`unavailable`), so a client cannot show one they did not.
     */
    chooseFlair(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof RoomFlairChosenAcceptanceSchema>>> {
      const parsed = ChooseRoomFlairSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.flair-choose',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: RoomFlairChosenAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner } = entered;
          const [own] = await p.flair.membersOf(lock, [owner.accountId], { shownOnly: false });
          if (own === undefined || !mayChoose(command.flair, earnedFlair(own.acts))) return refuse('unavailable');
          return ok(async () => {
            await p.flair.choose(lock, owner.accountId, storedChoice(command.flair));
            return RoomFlairChosenAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'room.flair',
              roomId: command.roomId,
              flair: command.flair,
            });
          });
        },
      });
    },
  };
}
