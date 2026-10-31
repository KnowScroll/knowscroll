import {
  ConstellationVoteAcceptanceSchema,
  NameConstellationSchema,
  ReadRoomSkySchema,
  RoomSkyViewSchema,
  type RoomNaming,
  type RoomSky,
} from '@knowscroll/contracts';
import type { z } from 'zod';
import type { PersonalAuthority } from '../../identity/public.js';
import { receiptBase, runCommand } from './command.js';
import { enterRoom } from './gate.js';
import {
  ok,
  refuse,
  roomEnvelope,
  type ConstellationRow,
  type Result,
  type RoomLock,
  type RoomPorts,
} from './ports.js';
import type { StarActName } from './ports.js';
import { resultOf } from '../domain/debate.js';
import { dayOf } from '../domain/rituals.js';
import {
  DEBATE_MIN_VOTERS,
  constellationCandidates,
  constellationOfStar,
  finishesConstellation,
  namingClosesAt,
  skyOf,
  starDecision,
  winningCandidate,
} from '../domain/sky.js';

/** How many stars a member may tap to read: the newest four constellations' worth. */
const STARS_SHOWN = 28;

export type AwardOutcome = 'awarded' | 'duplicate' | 'day_full';

/**
 * Awards the room a star for one act, inside the transaction of the act (D-174). The room's sky lock is taken first, so
 * the day's count, the unique insert and the constellation check are exact however many acts meet together. The same act
 * (same source) earns once; a full day earns nothing more and the act is not remembered; the seventh star of a
 * constellation finishes it and offers its three names. A star names no person. The caller decided that the act is one that
 * earns (a human answer marked useful, a debate with voters, the first right answer); this decides only whether the room has
 * room for it.
 */
export async function awardStar(
  p: RoomPorts,
  lock: RoomLock,
  topicId: string,
  act: StarActName,
  sourceKey: string,
  now: Date,
): Promise<AwardOutcome> {
  await p.sky.lock(lock);
  const day = dayOf(now);
  const decision = starDecision({
    alreadyAwarded: await p.sky.hasStar(lock, act, sourceKey),
    earnedToday: await p.sky.starsOn(lock, day),
    perDay: p.starsPerDay,
  });
  if (decision !== 'award') return decision;
  const before = await p.sky.starTotal(lock);
  await p.sky.insertStar(lock, {
    starId: p.newId(),
    act,
    sourceKey,
    at: now,
    day,
    constellationNo: constellationOfStar(before),
  });
  if (finishesConstellation(before + 1)) {
    const no = (before + 1) / 7;
    const used = (await p.sky.constellations(lock)).flatMap((row) => (row.name === null ? [] : [row.name]));
    await p.sky.insertConstellation(lock, {
      no,
      completedAt: now,
      candidates: constellationCandidates({ topicId, roomId: lock.roomId, no, used }),
      voteClosesAt: namingClosesAt(now),
    });
  }
  await p.rooms.announce(lock, now);
  return 'awarded';
}

/**
 * The constellation a vote may go to now: the earliest one with no name whose vote is still open (D-175). A room that
 * finishes another constellation inside the day of the first has two without a name; each keeps its own 24 hours, and a
 * vote goes to the older until its day ends.
 */
const votableOf = (constellations: readonly ConstellationRow[], now: Date): ConstellationRow | undefined =>
  constellations.find((row) => row.name === null && now.getTime() < row.voteClosesAt.getTime());

/**
 * Settles what time has made due since anyone last looked, as part of a member's own command in the room (D-175): a
 * debate whose close time passed closes, earning a star when enough different people voted, and a constellation whose name
 * vote closed gets the name with the most votes. There is no job: the first member command after the moment settles it,
 * and a room nobody opens settles nothing, which costs nobody anything. Each settlement is guarded by the row it changes,
 * so two commands at once settle once.
 */
export async function settleDue(p: RoomPorts, lock: RoomLock, topicId: string, now: Date): Promise<void> {
  const closed = await p.debates.closeDue(lock, now, (tally) => ({ winner: resultOf(tally).winner }));
  for (const debate of closed)
    if (debate.voters >= DEBATE_MIN_VOTERS)
      await awardStar(p, lock, topicId, 'debate_closed', debate.discussionId, now);
  const all = await p.sky.constellations(lock);
  const closedVotes = all.filter((row) => row.name === null && now.getTime() >= row.voteClosesAt.getTime());
  if (closedVotes.length === 0) return;
  await p.sky.lock(lock);
  // Oldest first: each takes the name its own votes chose, and one nobody voted for takes its first name. A name an
  // earlier constellation of the room holds is passed over, so no two share one.
  const used = all.flatMap((row) => (row.name === null ? [] : [row.name]));
  for (const naming of closedVotes) {
    const taken = naming.candidates.map((name) => used.includes(name)) as [boolean, boolean, boolean];
    const name = naming.candidates[winningCandidate(await p.sky.votes(lock, naming.no), taken)];
    await p.sky.name(lock, naming.no, name, now);
    used.push(name);
  }
  await p.rooms.announce(lock, now);
}

/** The room's sky from its stars and constellations, as a station and the room view draw it. */
export async function skyOfRoom(p: RoomPorts, lock: RoomLock): Promise<RoomSky> {
  const [stars, constellations] = await Promise.all([p.sky.starTotal(lock), p.sky.constellations(lock)]);
  const named = constellations.filter((row) => row.name !== null);
  return skyOf({
    stars,
    latestIsNamed: (constellations.at(-1)?.name ?? null) !== null,
    latestName: named.at(-1)?.name ?? undefined,
  });
}

/** The name vote as a member sees it: the three names, when it closes, and the counts only once they have voted. */
async function namingView(
  p: RoomPorts,
  lock: RoomLock,
  naming: ConstellationRow,
  accountId: string,
): Promise<RoomNaming> {
  const yourVote = await p.sky.yourVote(lock, naming.no, accountId);
  return {
    constellation: naming.no,
    candidates: [...naming.candidates] as RoomNaming['candidates'],
    closesAt: naming.voteClosesAt.toISOString(),
    ...(yourVote === undefined
      ? {}
      : { yourVote, votes: [...(await p.sky.votes(lock, naming.no))] as [number, number, number] }),
  };
}

/** The room's sky: read it, and vote for a constellation's name. Members only; neither is evidence for anyone. */
export function makeSkyUseCases(p: RoomPorts) {
  return {
    /**
     * A member reads the room's sky: how many stars are lit, the newest stars with the act and day of each, and the name
     * vote while one is open. Reads nothing about a person and writes nothing. Every refusal is `unavailable`.
     */
    async sky(authority: PersonalAuthority, input: unknown): Promise<Result<z.infer<typeof RoomSkyViewSchema>>> {
      const parsed = ReadRoomSkySchema.safeParse(input);
      if (!parsed.success) return refuse('invalid_input');
      const result = await p.withScope(authority, async (scope) => {
        const entered = await enterRoom(p, scope, parsed.data.roomId, 'read');
        if (entered?.member === undefined) return refuse('unavailable');
        const { lock, owner } = entered;
        const [sky, stars, constellations] = await Promise.all([
          skyOfRoom(p, lock),
          p.sky.latestStars(lock, STARS_SHOWN),
          p.sky.constellations(lock),
        ]);
        const naming = votableOf(constellations, p.now());
        return ok(
          RoomSkyViewSchema.parse({
            ...roomEnvelope(scope),
            readId: parsed.data.readId,
            status: 'ready',
            sky,
            stars,
            starsPerDay: p.starsPerDay,
            ...(naming === undefined ? {} : { naming: await namingView(p, lock, naming, owner.accountId) }),
          }),
        );
      });
      return result.kind === 'entered' ? result.value : refuse('unavailable');
    },

    /**
     * A member chooses one of the three names offered for the constellation being named, and may change the choice until the
     * vote closes (D-175). The vote is taken under the room's sky lock, so it either counts before the vote is settled or is
     * refused. It goes to the earliest constellation with no name whose vote is still open. A retry replays; a vote when
     * every vote has closed, or when no constellation is being named, is `unavailable`.
     */
    nameConstellation(
      authority: PersonalAuthority,
      input: unknown,
    ): Promise<Result<z.infer<typeof ConstellationVoteAcceptanceSchema>>> {
      const parsed = NameConstellationSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve(refuse('invalid_input'));
      const command = parsed.data;
      return runCommand(p, authority, {
        operation: 'rooms.sky-name',
        commandId: command.commandId,
        roomId: command.roomId,
        request: command,
        acceptance: ConstellationVoteAcceptanceSchema,
        requires: 'member',
        mode: 'read',
        async decide({ scope, entered, now }) {
          const { lock, owner } = entered;
          await p.sky.lock(lock);
          const naming = votableOf(await p.sky.constellations(lock), now);
          if (naming === undefined) return refuse('unavailable');
          return ok(async () => {
            await p.sky.setVote(lock, naming.no, owner.accountId, command.candidate as 0 | 1 | 2, now);
            return ConstellationVoteAcceptanceSchema.parse({
              ...receiptBase(scope, now, command.commandId),
              operation: 'sky.name',
              roomId: command.roomId,
              candidate: command.candidate,
            });
          });
        },
      });
    },
  };
}
