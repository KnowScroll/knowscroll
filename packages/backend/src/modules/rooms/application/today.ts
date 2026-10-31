import {
  AI_INHABITANT_LABELS,
  FlawSolvedAcceptanceSchema,
  ReadRoomTodaySchema,
  RoomTodaySchema,
  SolveFlawSchema,
  type AiAuthor,
  type RoomTodayFlaw,
  type RoomTodayQuestion,
  type RoomTodayStrip,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { nameOf, type CastMember } from '../domain/cast.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { FlawPayloadSchema, QuestionPayloadSchema, dayOf, type FlawPayload } from '../domain/rituals.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import {
  ok,
  refuse,
  roomEnvelope,
  type ContentCard,
  type Result,
  type RitualRow,
  type RoomLock,
  type RoomPorts,
} from './ports.js';
import { awardStar } from './sky.js';

/** How many earlier days' questions Today lists. */
const PAST_DAYS = 7;

/** A resident as the author of a ritual item: labelled, named from the cast, never a person. */
const residentOf = (cast: readonly CastMember[], inhabitant: 'explainer' | 'skeptic'): AiAuthor => ({
  kind: 'ai',
  inhabitant,
  name: nameOf(cast, inhabitant),
  label: AI_INHABITANT_LABELS[inhabitant],
});

const startOfDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** Today's approved items of a room, parsed; an item that no longer matches its stored shape is left out, never served. */
function itemsOf(rows: readonly RitualRow[]) {
  const question = rows.find((row) => row.kind === 'question');
  const flaw = rows.find((row) => row.kind === 'flaw');
  const questionPayload = question === undefined ? undefined : QuestionPayloadSchema.safeParse(question.payload);
  const flawPayload = flaw === undefined ? undefined : FlawPayloadSchema.safeParse(flaw.payload);
  return {
    question:
      question !== undefined && questionPayload?.success ? { row: question, payload: questionPayload.data } : undefined,
    flaw: flaw !== undefined && flawPayload?.success ? { row: flaw, payload: flawPayload.data } : undefined,
  };
}

/** What the Now strip says of today: the Today discussion and, when approved, the question and whether a flaw waits. */
export async function todayStrip(p: RoomPorts, lock: RoomLock, now: Date): Promise<RoomTodayStrip | undefined> {
  const discussion = await p.discussions.today(lock);
  if (discussion === undefined) return undefined;
  const { question, flaw } = itemsOf(await p.today.approvedOn(lock, dayOf(now)));
  return {
    discussionId: discussion.discussionId,
    ...(question === undefined ? {} : { prompt: question.payload.prompt }),
    flaw: flaw !== undefined,
  };
}

const cardOf = async (
  p: RoomPorts,
  scope: PersonalScopeTx,
  source: FlawPayload['source'] | { assetId: string; assetRevision: number },
): Promise<ContentCard> => {
  const [card] = await p.readContent(scope, [{ assetId: source.assetId, assetRevision: source.assetRevision }]);
  return card ?? { status: 'unavailable', target: { assetId: source.assetId, assetRevision: source.assetRevision } };
};

/** Today's question and Spot the flaw, and a member's one tap on the flaw. Members only; nothing here is evidence. */
export function makeToday(p: RoomPorts) {
  /** The flaw as this reader sees it: the sentences only until they have tapped, then the key, the Scroll and who found it. */
  async function flawView(
    scope: PersonalScopeTx,
    lock: RoomLock,
    accountId: string,
    cast: readonly CastMember[],
    flaw: { readonly row: RitualRow; readonly payload: FlawPayload },
  ): Promise<RoomTodayFlaw> {
    const base = { ritualId: flaw.row.ritualId, by: residentOf(cast, 'skeptic'), sentences: flaw.payload.sentences };
    const own = await p.today.solveOf(lock, flaw.row.ritualId, accountId);
    if (own === undefined) return { state: 'open', ...base };
    return {
      state: 'done',
      ...base,
      yourPick: own.picked,
      correct: own.correct,
      flawIndex: flaw.payload.flawIndex,
      original: flaw.payload.original,
      source: await cardOf(p, scope, flaw.payload.source),
      found: await p.today.found(lock, flaw.row.ritualId),
    };
  }

  return {
    /**
     * Today for a member: the day's question and Spot the flaw if an operator approved them, how many messages people have
     * written in Today since midnight, the questions of the days before, and the Today discussion where answers are written. A resident asks and says
     * so; the words are a template over a library Scroll and the altered sentence is checked and approved, never made while
     * someone waits. The flaw's key is withheld until the reader has tapped. Writes nothing.
     */
    async today(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomTodaySchema>>> {
      const parsed = ReadRoomTodaySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomTodaySchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const { lock, owner, standing } = entered;
        const discussion = await p.discussions.today(lock);
        if (discussion === undefined) return refuse('unavailable');
        const day = dayOf(p.now());
        const { question, flaw } = itemsOf(await p.today.approvedOn(lock, day));
        const { cast } = standing.room;
        const questionView: RoomTodayQuestion | undefined =
          question === undefined
            ? undefined
            : {
                ritualId: question.row.ritualId,
                prompt: question.payload.prompt,
                ...(question.payload.detail === undefined ? {} : { detail: question.payload.detail }),
                by: residentOf(cast, 'explainer'),
                source: await cardOf(p, scope, question.payload.source),
                messagesToday: await p.today.messagesSince(lock, discussion.discussionId, startOfDay(day)),
              };
        const past = (await p.today.pastQuestions(lock, day, PAST_DAYS)).flatMap((row) => {
          const payload = QuestionPayloadSchema.safeParse(row.payload);
          return payload.success ? [{ day: row.day, prompt: payload.data.prompt }] : [];
        });
        return ok(
          RoomTodaySchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            day,
            discussionId: discussion.discussionId,
            canPost: roomAcceptsPosts(standing.room.status),
            ...(questionView === undefined ? {} : { question: questionView }),
            ...(flaw === undefined ? {} : { flaw: await flawView(scope, lock, owner.accountId, cast, flaw) }),
            past,
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * The member taps one sentence of today's Spot the flaw. The tap is final and the key shows after it. A right tap is
     * the first right answer of the day the room has had, within its daily star cap, earns the room a star in this same
     * transaction (D-174); a later right tap, a wrong one or a retry earns nothing more. A tap on an item that is not
     * approved, not today's, or on a sentence the passage does not have is refused. The same command again, and a second
     * command for the same item, answer with the first tap. It is a play result: nothing here is evidence for anyone, and
     * it is stored only while the person's recording is on. While it is paused (or the device's generation is out of date)
     * nothing is stored, the key stays on the server and the answer says `not_saved` so the screen can say so plainly (D-083,
     * D-182, D-176).
     */
    solveFlaw(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof FlawSolvedAcceptanceSchema>>> {
      const parsed = SolveFlawSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.today-solve',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: FlawSolvedAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async gate({ scope }) {
          const fence = await p.fenceRecording(scope, command.recordingGeneration);
          if (fence.kind === 'recording') return undefined;
          if (fence.kind !== 'paused' && fence.kind !== 'stale') return refuse('unavailable');
          return ok(
            FlawSolvedAcceptanceSchema.parse({
              ...roomEnvelope(scope),
              commandId: command.commandId,
              outcome: 'not_saved',
              operation: 'today.solve',
              roomId: command.roomId,
              ritualId: command.ritualId,
              reason: fence.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
            }),
          );
        },
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const row = await p.today.approved(lock, command.ritualId);
          if (row?.kind !== 'flaw' || row.day !== dayOf(now)) return refuse('unavailable');
          const flaw = FlawPayloadSchema.safeParse(row.payload);
          if (!flaw.success) return refuse('unavailable');
          if (command.sentence >= flaw.data.sentences.length) return refuse('invalid_input');
          const earlier = await p.today.solveOf(lock, command.ritualId, owner.accountId);
          const picked = earlier?.picked ?? command.sentence;
          const correct = earlier?.correct ?? command.sentence === flaw.data.flawIndex;
          return ok(async () => {
            let star = false;
            if (earlier === undefined) {
              await p.today.insertSolve(lock, {
                ritualId: command.ritualId,
                accountId: owner.accountId,
                picked,
                correct,
                now,
              });
              star =
                correct &&
                (await awardStar(p, lock, standing.room.topic.id, 'daily_solved', command.ritualId, now)) === 'awarded';
            }
            return FlawSolvedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'today.solve',
              roomId: command.roomId,
              ritualId: command.ritualId,
              correct,
              flawIndex: flaw.data.flawIndex,
              original: flaw.data.original,
              star,
            });
          });
        },
      });
    },
  };
}
