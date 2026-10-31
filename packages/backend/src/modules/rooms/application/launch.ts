import {
  AnswerLaunchSchema,
  FinishLaunchSchema,
  JoinLaunchSchema,
  LAUNCH_HOST,
  LaunchAnsweredAcceptanceSchema,
  LaunchFinishedAcceptanceSchema,
  LaunchJoinedAcceptanceSchema,
  LaunchStartedAcceptanceSchema,
  ReadRoomLaunchSchema,
  RoomLaunchSchema,
  StartLaunchSchema,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { LaunchDeckSchema } from '../domain/launch-deck.js';
import {
  RESULTS_KEPT_DAYS,
  answerTiming,
  earnsStar,
  endsAt,
  phaseAt,
  playedCount,
  resultsOf,
  startsAtFrom,
} from '../domain/launch.js';
import { receiptBase, runCommand, type CommandContext, type CommandSpec } from './command.js';
import { enterRoom } from './gate.js';
import { deckOf, launchViewOf, startDecision } from './launch-view.js';
import { ok, refuse, roomEnvelope, type Result, type RoomLock, type RoomPorts } from './ports.js';
import { awardStar } from './sky.js';

/** Results of a Launch that ended before this moment are past their seven days. */
const resultsKeptUntil = (now: Date): Date => new Date(now.getTime() - RESULTS_KEPT_DAYS * 86_400_000);

/**
 * Settles the room's Launch when its play time has passed (D-178): it is marked finished once, with how many people answered, and
 * the room earns its star when at least two did. There is no job: the first member command in the room after the end settles it
 * (a presence beat, which an open room sends every 25 seconds, or a Launch command), exactly as D-175 settles a constellation's name.
 * The Launch row is taken FOR UPDATE, so an answer in flight commits first and the finished Launch holds every answer that was
 * accepted; the sky lock follows it, last, as everywhere. Two commands at once settle it once.
 *
 * A Launch is finished **when its play time ended**, not when someone noticed: a room nobody opened for three days still shows no
 * podium (it is read for a day from the end), its star counts against the day it ended, and its answers are kept seven days from
 * that end (D-178, D-220, D-221). The results of every Launch past their seven days are deleted by the same commands, so a room that
 * stops playing does not keep them until its next start.
 */
export async function settleLaunches(p: RoomPorts, lock: RoomLock, topicId: string, now: Date): Promise<void> {
  const running = await p.launches.unfinished(lock, 'none');
  if (running === undefined || now.getTime() < endsAt(running.startsAt).getTime()) {
    await p.launches.purgeResults(lock, resultsKeptUntil(now));
    return;
  }
  const row = await p.launches.unfinished(lock, 'update');
  if (row === undefined || now.getTime() < endsAt(row.startsAt).getTime()) return;
  const ended = endsAt(row.startsAt);
  const results = resultsOf(await p.launches.players(lock, row.launchId), await p.launches.answers(lock, row.launchId));
  const played = playedCount(results);
  const star =
    earnsStar(played) && (await awardStar(p, lock, topicId, 'launch_finished', row.launchId, now, ended)) === 'awarded';
  if (await p.launches.finish(lock, row.launchId, { at: ended, played, star })) await p.rooms.announce(lock, now);
  await p.launches.purgeResults(lock, resultsKeptUntil(now));
}

/** What a command that records the person as playing answers while their recording is paused or the device is out of date. */
function notSavedGate<A extends object>(
  p: RoomPorts,
  operation: string,
  command: { readonly commandId: string; readonly roomId: string; readonly recordingGeneration: number },
  acceptance: z.ZodType<A>,
): NonNullable<CommandSpec<A>['gate']> {
  return async ({ scope }: CommandContext) => {
    const fence = await p.fenceRecording(scope, command.recordingGeneration);
    if (fence.kind === 'recording') return undefined;
    if (fence.kind !== 'paused' && fence.kind !== 'stale') return refuse('unavailable');
    return ok(
      acceptance.parse({
        ...roomEnvelope(scope),
        commandId: command.commandId,
        outcome: 'not_saved',
        operation,
        roomId: command.roomId,
        reason: fence.kind === 'paused' ? 'recording_paused' : 'recording_generation_stale',
      }),
    );
  };
}

/**
 * The Launch: a live five-question quiz that a room plays together. Every method is for a current member and every refusal is the
 * same `unavailable`. The questions are an approved deck of library Scroll calls, frozen onto the Launch; no model is asked, ever, so a
 * Launch makes no call and the host speaks only template lines the client draws. Starting, joining and answering are play results
 * the server keeps, so each is refused (`not_saved`) while recording is paused (D-083). Nothing here is evidence for anyone (D-063).
 */
export function makeLaunch(p: RoomPorts) {
  return {
    /**
     * The room's Launch for a member: the one running (the lobby, a question with its time left, an answer) or, for a day, the last
     * one's podium; and whether they may start one now. The server's clock against the stored start decides the phase; a question
     * that is open carries no key, no count and no name. Writes nothing.
     */
    async launch(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomLaunchSchema>>> {
      const parsed = ReadRoomLaunchSchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope): Promise<Result<z.infer<typeof RoomLaunchSchema>>> => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const { lock, owner } = entered;
        const now = p.now();
        const latest = await p.launches.latest(lock);
        const launch = await launchViewOf({ p, scope, lock, readerId: owner.accountId, now }, latest);
        const running = launch !== undefined && launch.phase !== 'finished';
        const decision = running ? undefined : await startDecision(p, entered, latest, now);
        return ok(
          RoomLaunchSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            host: LAUNCH_HOST,
            ...(launch === undefined ? {} : { launch }),
            ...(decision === undefined
              ? {}
              : { start: decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason } }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * A member starts a Launch: the newest approved deck of today or yesterday that nobody has played is frozen onto it, the starter
     * is in, and the lobby opens for twenty seconds. It needs an open room, two people with the room open, the room's rest between
     * Launches over, and a deck whose Scrolls are all still current; otherwise it is refused and the read says why. The room is
     * locked FOR UPDATE, so two starts at once make one Launch. The same command again replays.
     */
    startLaunch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof LaunchStartedAcceptanceSchema>>> {
      const parsed = StartLaunchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.launch-start',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: LaunchStartedAcceptanceSchema,
        requires: 'member',
        mode: 'write',
        gate: notSavedGate(p, 'launch.start', command, LaunchStartedAcceptanceSchema),
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          await settleLaunches(p, lock, standing.room.topic.id, now);
          if ((await p.launches.unfinished(lock, 'none')) !== undefined) return refuse('unavailable');
          const decision = await startDecision(p, entered, await p.launches.latest(lock), now);
          if (!decision.allowed) return refuse(decision.reason === 'resting' ? 'rate_limited' : 'unavailable');
          const deck = LaunchDeckSchema.safeParse(decision.deck);
          if (!deck.success) return refuse('unavailable');
          // The cited Scrolls must still be the current ones that anyone may be served: a Scroll withdrawn or corrected since the
          // deck was approved is not asked. Read through the caller's own scope, so no network wait runs inside the transaction.
          const refs = [
            ...new Map(
              deck.data.questions.map((question) => [
                `${question.source.assetId}:${String(question.source.assetRevision)}`,
                { assetId: question.source.assetId, assetRevision: question.source.assetRevision },
              ]),
            ).values(),
          ];
          const cards = await p.readContent(scope, refs);
          if (cards.length !== refs.length || cards.some((card) => card.status !== 'available'))
            return refuse('unavailable');
          return ok(async () => {
            const launchId = p.newId();
            const startsAt = startsAtFrom(now);
            await p.launches.purgeResults(lock, resultsKeptUntil(now));
            await p.launches.insert(lock, {
              launchId,
              deckRitualId: decision.deckRitualId,
              questions: deck.data.questions,
              startsAt,
              now,
            });
            await p.launches.addPlayer(lock, launchId, owner.accountId, now);
            await p.rooms.announce(lock, now);
            return LaunchStartedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'launch.start',
              roomId: command.roomId,
              launchId,
              startsInMs: startsAt.getTime() - now.getTime(),
            });
          });
        },
      });
    },

    /** A member says they are in, while the Launch is on and not over. The same command again, and a second tap, change nothing. */
    joinLaunch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof LaunchJoinedAcceptanceSchema>>> {
      const parsed = JoinLaunchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.launch-join',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: LaunchJoinedAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        gate: notSavedGate(p, 'launch.join', command, LaunchJoinedAcceptanceSchema),
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const row = await p.launches.unfinished(lock, 'share');
          if (row?.launchId !== command.launchId || phaseAt(row.startsAt, now).kind === 'over')
            return refuse('unavailable');
          return ok(async () => {
            if (await p.launches.addPlayer(lock, row.launchId, owner.accountId, now)) await p.rooms.announce(lock, now);
            return LaunchJoinedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'launch.join',
              roomId: command.roomId,
              launchId: row.launchId,
            });
          });
        },
      });
    },

    /**
     * A player's answer to the question that is open. Whether it came in time is the server's own clock against the stored start,
     * and how long it took is measured from the question's opening to now: a device sends the round and the option and nothing
     * about time. Answering is joining, so a member who never tapped Join is in by answering. The first answer to a round stands;
     * the same command again, and another for the same round, answer with the first. A late answer, one for a round that is not the
     * open one and an option the question does not have are refused. Nothing in the acceptance says whether it was right.
     */
    answerLaunch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof LaunchAnsweredAcceptanceSchema>>> {
      const parsed = AnswerLaunchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.launch-answer',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: LaunchAnsweredAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        gate: notSavedGate(p, 'launch.answer', command, LaunchAnsweredAcceptanceSchema),
        async decide({ scope, entered, now }) {
          const { lock, owner, standing } = entered;
          if (!roomAcceptsPosts(standing.room.status)) return refuse('unavailable');
          const row = await p.launches.unfinished(lock, 'share');
          if (row?.launchId !== command.launchId) return refuse('unavailable');
          const timing = answerTiming(row.startsAt, command.round, now);
          const deck = deckOf(row);
          const question = deck?.questions[command.round - 1];
          if (timing === undefined || question === undefined) return refuse('unavailable');
          if (command.choice >= question.options.length) return refuse('invalid_input');
          return ok(async () => {
            if (await p.launches.addPlayer(lock, row.launchId, owner.accountId, now)) await p.rooms.announce(lock, now);
            await p.launches.addAnswer(lock, {
              launchId: row.launchId,
              accountId: owner.accountId,
              round: command.round,
              choice: command.choice,
              correct: command.choice === question.answer,
              elapsedMs: timing.elapsedMs,
              now,
            });
            return LaunchAnsweredAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'launch.answer',
              roomId: command.roomId,
              launchId: row.launchId,
              round: command.round,
            });
          });
        },
      });
    },

    /**
     * A member's device found the Launch over: it is settled now (marked finished, the room's star) so the podium can say so. Refused
     * while the server's clock says it is not over yet, so a device that runs fast cannot end it early. A Launch already settled
     * answers as accepted. Any member may ask; a retry replays.
     */
    finishLaunch(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof LaunchFinishedAcceptanceSchema>>> {
      const parsed = FinishLaunchSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.launch-finish',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: LaunchFinishedAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, standing } = entered;
          const latest = await p.launches.latest(lock);
          if (latest?.launchId !== command.launchId) return refuse('unavailable');
          if (latest.state === 'live' && now.getTime() < endsAt(latest.startsAt).getTime())
            return refuse('unavailable');
          return ok(async () => {
            await settleLaunches(p, lock, standing.room.topic.id, now);
            return LaunchFinishedAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'launch.finish',
              roomId: command.roomId,
              launchId: command.launchId,
            });
          });
        },
      });
    },
  };
}
