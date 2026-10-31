import {
  LAUNCH_ANSWER_SECONDS,
  LAUNCH_FACES_MAX,
  LAUNCH_HOST,
  ReadReplayRoundSchema,
  ReadRoomReplaySchema,
  ReplayRoundSchema,
  RoomReplaySchema,
  type RoomReplayStrip,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { LaunchDeck } from '../domain/launch-deck.js';
import {
  playedBy,
  replayOffered,
  replayWindow,
  roundFigures,
  visibleTo,
  type RecordedAnswer,
} from '../domain/replay.js';
import { dayOf } from '../domain/rituals.js';
import { enterRoom, type EnteredRoom } from './gate.js';
import { deckOf, facesOf } from './launch-view.js';
import type { LaunchRow } from './launch-ports.js';
import { ok, refuse, roomEnvelope, type Result, type RoomPorts } from './ports.js';

/** A Launch the reader may replay now, with the answers the people who played it gave. */
interface Replayable {
  readonly row: LaunchRow;
  readonly deck: LaunchDeck;
  /** Every recorded answer of the Launch. Never sent as it is: a screen gets figures from `visibleTo` only. */
  readonly answers: readonly RecordedAnswer[];
  /** People the reader has blocked: left out of every count and face they are shown. */
  readonly hidden: ReadonlySet<string>;
}

/**
 * The Launch the reader may replay in this room at this moment, or none (D-241): the newest whose play time has ended and whose
 * answers are still kept, that somebody the reader has not blocked answered and the reader did not. Its deck must still be what anyone
 * may be served: a Scroll withdrawn or corrected since is not asked again, as a start would refuse it. Reads only.
 */
async function replayableFor(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom,
  now: Date,
): Promise<Replayable | undefined> {
  const { lock, owner } = entered;
  const row = await p.launches.replayable(lock, replayWindow(now));
  const deck = row === undefined ? undefined : deckOf(row);
  if (row === undefined || deck === undefined) return undefined;
  const answers: readonly RecordedAnswer[] = await p.launches.answers(lock, row.launchId);
  const others = [
    ...new Set(answers.map((answer) => answer.accountId).filter((account) => account !== owner.accountId)),
  ];
  const hidden = others.length === 0 ? new Set<string>() : await p.blocked(scope, owner.accountId, others);
  if (!replayOffered(answers, hidden, owner.accountId)) return undefined;
  const refs = [
    ...new Map(
      deck.questions.map((question) => [
        `${question.source.assetId}:${String(question.source.assetRevision)}`,
        { assetId: question.source.assetId, assetRevision: question.source.assetRevision },
      ]),
    ).values(),
  ];
  const cards = await p.readContent(scope, refs);
  if (cards.length !== refs.length || cards.some((card) => card.status !== 'available')) return undefined;
  return { row, deck, answers, hidden };
}

/**
 * What a member's own view of the room says of a replay: the day of the Launch that can be replayed, or nothing. It names no person
 * and no number; the replay read has those.
 */
export async function replayStrip(
  p: RoomPorts,
  scope: PersonalScopeTx,
  entered: EnteredRoom,
  now: Date,
): Promise<RoomReplayStrip | undefined> {
  const found = await replayableFor(p, scope, entered, now);
  return found === undefined ? undefined : { day: dayOf(found.row.startsAt) };
}

/**
 * The replay of a finished Launch (R3 F, D-241): last night's quiz played again alone against the answers the people who played it
 * gave. Both methods are for a current member, every refusal is the same `unavailable`, and neither writes anything: no row about the
 * person replaying, no receipt, no star and no model call. The questions go out without their key; the key comes with each answer, as
 * it came to the people who played. The host is the Launch's, labelled AI, and speaks template lines on the screen.
 */
export function makeReplay(p: RoomPorts) {
  return {
    /**
     * The Launch this member may replay and its five questions (no keys), or none when there is nothing real to replay: no finished
     * Launch within its seven days, one they played themselves, or one only people they blocked played. `played` is how many people
     * answered, as this reader sees it.
     */
    async replay(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomReplaySchema>>> {
      const parsed = ReadRoomReplaySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomReplaySchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const found = await replayableFor(p, scope, entered, p.now());
        return ok(
          RoomReplaySchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            host: LAUNCH_HOST,
            ...(found === undefined
              ? {}
              : {
                  replay: {
                    launchId: found.row.launchId,
                    day: dayOf(found.row.startsAt),
                    played: playedBy(visibleTo(found.answers, found.hidden)),
                    questions: found.deck.questions.map((question, index) => ({
                      round: index + 1,
                      prompt: question.prompt,
                      options: question.options,
                    })),
                    answerSeconds: LAUNCH_ANSWER_SECONDS,
                  },
                }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * One question of the replay answered (or, when the time ran out, shown): the right option and the reason, how many of the
     * people who played answered it and got it right, the faces of those who did, and, for a right choice with a time, how many of
     * them were quicker. Nobody is named as wrong, and nothing is kept about the person asking. A Launch that is not the one this
     * member may replay now is `unavailable`; an option the question does not have is `invalid_input`.
     */
    async replayRound(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ReplayRoundSchema>>> {
      const parsed = ReadReplayRoundSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const read = parsed.data;
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof ReplayRoundSchema>>> => {
        const entered = await enterRoom(p, scope, read.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const found = await replayableFor(p, scope, entered, p.now());
        const question = found?.deck.questions[read.round - 1];
        if (found === undefined || found.row.launchId !== read.launchId || question === undefined)
          return refuse('unavailable');
        if (read.choice !== undefined && read.choice >= question.options.length) return refuse('invalid_input');
        const ownElapsedMs = read.choice === question.answer ? read.elapsedMs : undefined;
        const figures = roundFigures(visibleTo(found.answers, found.hidden), read.round, ownElapsedMs);
        const { faces } = await facesOf(p, scope, entered.owner.accountId, figures.calledIt, LAUNCH_FACES_MAX);
        return ok(
          ReplayRoundSchema.parse({
            ...roomEnvelope(scope),
            readId: read.readId,
            status: 'ready',
            launchId: found.row.launchId,
            round: read.round,
            correct: question.answer,
            explain: question.explain,
            locked: figures.locked,
            right: figures.right,
            calledIt: faces,
            ...(figures.quicker === undefined ? {} : { quicker: figures.quicker }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },
  };
}
