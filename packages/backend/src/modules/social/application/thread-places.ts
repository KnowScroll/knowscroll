import {
  ReadThreadPlacesSchema,
  SetThreadPlaceHiddenSchema,
  SetThreadPlaceSchema,
  ThreadPlaceAcceptanceSchema,
  ThreadPlaceHiddenAcceptanceSchema,
  ThreadPlacesSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { dayOf, movePlace, shownPlaces } from '../domain/places.js';
import { refuse, threadEnvelope, type Result } from './ports.js';
import { makeThreadCommandFrame, ok, takingPart } from './thread-command-frame.js';
import { enterThread, threadRefOf } from './thread-gate.js';
import type { ThreadPorts, ThreadRow } from './thread-ports.js';

/**
 * Party places: where each member of a content thread is in its series (D-065, T3 Q6). A place is a part,
 * `on` or `finished`, and a day. It is written only by the member's own command, from their own client,
 * and the server never reads another member's exploration to make it. Each command and read runs in the
 * caller's personal scope in the thread's lock order (personal root, own account gate, the thread's own
 * root) and rechecks membership, so a stranger, a leaver and a removed member get nothing and cannot tell
 * why. A place is not consumption evidence for anyone.
 */
export function makePlaces(p: ThreadPorts) {
  const { receiptBase, inThread } = makeThreadCommandFrame(p);

  /** The parts of the thread's series, or none when it is a single item (or its root is gone). */
  async function partsOf(scope: PersonalScopeTx, thread: ThreadRow): Promise<ReadonlySet<number>> {
    const sequence = await p.readSequence(scope, thread.root);
    return new Set(sequence?.kind === 'series' ? sequence.units.map((unit) => unit.part) : []);
  }

  return {
    /**
     * Reports the caller's own place. The part must be one of the series' parts, or the command is
     * invalid. While the caller hides, nothing is written and the answer says so. A place only moves
     * forward, so a repeat, or an earlier part, changes nothing; a change tells every member's open
     * thread to read again (a disposable hint that carries nothing).
     */
    setPlace(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadPlaceAcceptanceSchema>>> {
      const parsed = SetThreadPlaceSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-place',
        command,
        request: command,
        acceptance: ThreadPlaceAcceptanceSchema,
        async decide({ scope, entered, now }) {
          if (!(await partsOf(scope, entered.thread)).has(command.part)) return refuse('invalid_input');
          const accepted = (result: 'stored' | 'unchanged' | 'hidden') =>
            ThreadPlaceAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'thread.place',
              thread: threadRefOf(entered),
              result,
            });
          if (entered.own.placeHidden) return ok({ write: () => Promise.resolve(accepted('hidden')), announce: [] });
          const accountId = entered.owner.accountId;
          const current = await p.places.find(entered.lock, accountId);
          const move = movePlace(current, command, dayOf(now));
          if (move.kind === 'keep') return ok({ write: () => Promise.resolve(accepted('unchanged')), announce: [] });
          return ok({
            write: async () => {
              await p.places.save(entered.lock, accountId, move.place);
              return accepted('stored');
            },
            announce: takingPart(entered),
          });
        },
      });
    },

    /**
     * Hides or shows where the caller is in this thread. The wanted state is the command, so a repeat is
     * accepted without a change. Hiding deletes the caller's place and tells the open threads of everyone
     * who takes part; showing writes nothing, because the place comes only from the caller's next open.
     */
    setPlaceHidden(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ThreadPlaceHiddenAcceptanceSchema>>> {
      const parsed = SetThreadPlaceHiddenSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return inThread(authority, {
        operation: 'social.thread-place-hidden',
        command,
        request: command,
        acceptance: ThreadPlaceHiddenAcceptanceSchema,
        decide({ scope, entered, now }) {
          const changed = entered.own.placeHidden !== command.hidden;
          return Promise.resolve(
            ok({
              write: async () => {
                if (changed) {
                  await p.places.setHidden(entered.lock, entered.owner.accountId, command.hidden);
                  if (command.hidden) await p.places.remove(entered.lock, entered.owner.accountId);
                }
                return ThreadPlaceHiddenAcceptanceSchema.parse({
                  ...receiptBase(scope, now, command.commandId),
                  operation: 'thread.place-hidden',
                  thread: threadRefOf(entered),
                  hidden: command.hidden,
                  changed,
                });
              },
              announce: changed && command.hidden ? takingPart(entered) : [],
            }),
          );
        },
      });
    },

    /**
     * The places the caller may see, read under the thread's lock: members who take part and share, and
     * neither side of a block with the caller. Reading writes nothing and creates no receipt, notice or
     * evidence. A thread that is not a series has no place to show: `setPlace` refuses its parts.
     */
    async places(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof ThreadPlacesSchema>>> {
      const parsed = ReadThreadPlacesSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const query = parsed.data;
      const result = await p.withScope(authority, async (scope) => {
        const envelope = { ...threadEnvelope(scope), readId: query.readId };
        const entered = await enterThread(p, scope, query.thread, 'read');
        if (!entered) return ok(ThreadPlacesSchema.parse({ ...envelope, status: 'unavailable' }));
        const readerAccountId = entered.owner.accountId;
        const rows = await p.places.list(entered.lock);
        const blocked = await p.places.blockedWith(
          entered.lock,
          readerAccountId,
          rows.map((row) => row.accountId),
        );
        const shown = shownPlaces({
          readerAccountId,
          members: entered.members,
          rows,
          blockedWithReader: blocked,
          nameOf: (member) => member.person.displayName,
        });
        return ok(
          ThreadPlacesSchema.parse({
            ...envelope,
            status: 'ready',
            thread: threadRefOf(entered),
            hidden: entered.own.placeHidden,
            places: shown.map(({ member, place }) => ({
              person: member.person,
              you: member.accountId === readerAccountId,
              part: place.part,
              state: place.state,
              day: place.day,
            })),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
