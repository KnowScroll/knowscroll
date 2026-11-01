import {
  LAUNCH_QUESTIONS,
  ROOM_PRESENCE_LEASE_MS,
  type LaunchFace,
  type LaunchStartBlock,
  type LaunchView,
  type RoomLaunchStrip,
} from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import { LaunchDeckSchema, type LaunchDeck } from '../domain/launch-deck.js';
import {
  MIN_HERE_TO_START,
  endsAt,
  earliestDeckDay,
  phaseAt,
  playedCount,
  podiumOf,
  podiumReadable,
  resultsOf,
  type PlayerResult,
} from '../domain/launch.js';
import { dayOf } from '../domain/rituals.js';
import type { EnteredRoom } from './gate.js';
import type { LaunchRow, StoredAnswer } from './launch-ports.js';
import type { RoomLock, RoomPorts } from './ports.js';
import { liveSession } from './watch-view.js';

/** The most people one read looks up. */
const PEOPLE_READ_LIMIT = 200;

/** A Launch's frozen questions, parsed. A row that no longer matches the stored shape has none and is never served. */
export function deckOf(row: LaunchRow): LaunchDeck | undefined {
  const parsed = LaunchDeckSchema.safeParse({ questions: row.questions });
  return parsed.success ? parsed.data : undefined;
}

/** When a Launch was over: the end of its last round, whether or not anyone has settled it yet (a settlement is not an event of the game). */
const overAt = (row: LaunchRow): Date => endsAt(row.startsAt);

/**
 * People as faces for this reader: the reader first, then the others in the order given, never a person the reader blocked (D-160:
 * left out, not drawn as a placeholder, so no count can give them away) and never a person with no public profile.
 */
export async function facesOf(
  p: RoomPorts,
  scope: PersonalScopeTx,
  readerId: string,
  accountIds: readonly string[],
  limit: number,
): Promise<{ readonly faces: LaunchFace[]; readonly blocked: ReadonlySet<string> }> {
  const others = accountIds.filter((account) => account !== readerId);
  const [people, blocked] = await Promise.all([
    p.people.byAccounts(scope, [readerId, ...others]),
    others.length === 0 ? Promise.resolve(new Set<string>()) : p.blocked(scope, readerId, others),
  ]);
  const shown = [
    ...(accountIds.includes(readerId) ? [readerId] : []),
    ...others.filter((account) => !blocked.has(account)),
  ].flatMap((account) => {
    const person = people.get(account);
    return person === undefined ? [] : [{ person, you: account === readerId }];
  });
  return { faces: shown.slice(0, limit), blocked };
}

interface Reading {
  readonly p: RoomPorts;
  readonly scope: PersonalScopeTx;
  readonly lock: RoomLock;
  readonly readerId: string;
  readonly now: Date;
}

const OWN_ANSWER = (answers: readonly StoredAnswer[], readerId: string, round: number) =>
  answers.find((answer) => answer.accountId === readerId && answer.round === round);

/** The lobby: who is in. */
async function lobbyView(read: Reading, row: LaunchRow, startsInMs: number): Promise<LaunchView> {
  const players = await read.p.launches.players(read.lock, row.launchId);
  const { faces } = await facesOf(
    read.p,
    read.scope,
    read.readerId,
    players.map((player) => player.accountId),
    12,
  );
  return {
    phase: 'lobby',
    launchId: row.launchId,
    startsInMs,
    players: faces,
    youIn: players.some((player) => player.accountId === read.readerId),
  };
}

/**
 * The question that is open: its words and the time left, and the reader's own answer. Nothing says which option is right, how many
 * have answered or who: the view has no field for it (the contract's own shape), and no query here reads it.
 */
async function openView(
  read: Reading,
  row: LaunchRow,
  deck: LaunchDeck,
  round: number,
  closesInMs: number,
): Promise<LaunchView> {
  const question = deck.questions[round - 1]!;
  // While the question is open only the reader's own answer is read: nobody else's row is touched.
  const mine = await read.p.launches.ownAnswer(read.lock, row.launchId, round, read.readerId);
  const youIn = await read.p.launches.isPlayer(read.lock, row.launchId, read.readerId);
  return {
    phase: 'open',
    launchId: row.launchId,
    round,
    of: LAUNCH_QUESTIONS,
    prompt: question.prompt,
    options: question.options,
    closesInMs,
    ...(mine === undefined ? {} : { yourChoice: mine.choice }),
    youIn,
  };
}

/**
 * The answer of a question that has closed: the right option and the reason, how many answered, and the people who got it right.
 * A person the reader blocked is left out of the count and the faces for this reader only.
 */
async function revealView(
  read: Reading,
  row: LaunchRow,
  deck: LaunchDeck,
  round: number,
  timing: { readonly nextInMs: number; readonly last: boolean },
): Promise<LaunchView> {
  const question = deck.questions[round - 1]!;
  const [answers, players] = await Promise.all([
    read.p.launches.answers(read.lock, row.launchId),
    read.p.launches.players(read.lock, row.launchId),
  ]);
  const answered = answers.filter((answer) => answer.round === round);
  const right = answered.filter((answer) => answer.correct).map((answer) => answer.accountId);
  const { faces, blocked } = await facesOf(read.p, read.scope, read.readerId, right, 12);
  const mine = OWN_ANSWER(answers, read.readerId, round);
  return {
    phase: 'reveal',
    launchId: row.launchId,
    round,
    of: LAUNCH_QUESTIONS,
    prompt: question.prompt,
    options: question.options,
    correct: question.answer,
    explain: question.explain,
    ...(mine === undefined ? {} : { yourChoice: mine.choice }),
    locked: answered.filter((answer) => !blocked.has(answer.accountId)).length,
    right: right.filter((account) => !blocked.has(account)).length,
    calledIt: faces,
    yourScore: answers.filter((answer) => answer.accountId === read.readerId && answer.correct && answer.round <= round)
      .length,
    nextInMs: timing.nextInMs,
    last: timing.last,
    youIn: players.some((player) => player.accountId === read.readerId),
  };
}

/**
 * The podium of a Launch that is over: up to three people with a right answer, best first, and the reader's own squares. A person
 * the reader blocked keeps their place without a name, so the order is true and nothing is hidden by moving others up.
 */
async function podiumView(read: Reading, row: LaunchRow): Promise<LaunchView> {
  const [players, answers] = await Promise.all([
    read.p.launches.players(read.lock, row.launchId),
    read.p.launches.answers(read.lock, row.launchId),
  ]);
  const results = resultsOf(players, answers);
  const podium = podiumOf(results);
  const onPodium = podium.map((result) => result.accountId);
  const others = onPodium.filter((account) => account !== read.readerId);
  const [people, blocked] = await Promise.all([
    read.p.people.byAccounts(read.scope, onPodium),
    others.length === 0 ? Promise.resolve(new Set<string>()) : read.p.blocked(read.scope, read.readerId, others),
  ]);
  const entries = podium.flatMap((result) => {
    const base = { place: result.place, score: result.score, you: result.accountId === read.readerId };
    if (blocked.has(result.accountId)) return [{ ...base, blockedByYou: true }];
    const person = people.get(result.accountId);
    return person === undefined ? [] : [{ ...base, person, blockedByYou: false }];
  });
  const own: PlayerResult | undefined = results.find((result) => result.accountId === read.readerId);
  const ownPlace = podium.find((result) => result.accountId === read.readerId)?.place;
  return {
    phase: 'finished',
    launchId: row.launchId,
    played: row.played ?? playedCount(results),
    podium: entries,
    ...(own === undefined
      ? {}
      : {
          you: { score: own.score, squares: [...own.squares], ...(ownPlace === undefined ? {} : { place: ownPlace }) },
        }),
    star: row.star ?? false,
    day: dayOf(row.startsAt),
    youIn: own !== undefined,
  };
}

/**
 * The room's Launch as this reader sees it now, or none: the one running (lobby, a question, its answer) or the last one for a day
 * after it finished. Reads only; the phase is the server's clock against the stored start, so nothing is advanced by looking.
 */
export async function launchViewOf(read: Reading, row: LaunchRow | undefined): Promise<LaunchView | undefined> {
  if (row === undefined) return undefined;
  const phase = phaseAt(row.startsAt, read.now);
  if (phase.kind === 'over' || row.state === 'finished')
    return podiumReadable(overAt(row), read.now) ? podiumView(read, row) : undefined;
  const deck = deckOf(row);
  if (deck === undefined) return undefined;
  if (phase.kind === 'lobby') return lobbyView(read, row, phase.startsInMs);
  if (phase.kind === 'open') return openView(read, row, deck, phase.round, phase.closesInMs);
  return revealView(read, row, deck, phase.round, { nextInMs: phase.nextInMs, last: phase.last });
}

/** Whether the reader may start a Launch now, and if not the first reason that stops it. */
export async function startDecision(
  p: RoomPorts,
  entered: EnteredRoom,
  latest: LaunchRow | undefined,
  now: Date,
): Promise<
  | { readonly allowed: true; readonly deckRitualId: string; readonly deck: unknown }
  | { readonly allowed: false; readonly reason: LaunchStartBlock }
> {
  const { lock, owner, standing } = entered;
  if (!roomAcceptsPosts(standing.room.status)) return { allowed: false, reason: 'room_paused' };
  // A Reel being watched together has the stage (D-257): a Launch waits until it is over.
  if ((await liveSession(p, lock, now)) !== undefined) return { allowed: false, reason: 'stage_busy' };
  if (latest !== undefined && now.getTime() - latest.createdAt.getTime() < p.launchGapMs)
    return { allowed: false, reason: 'resting' };
  const deck = await p.launches.readyDeck(lock, earliestDeckDay(now), dayOf(now));
  if (deck === undefined) return { allowed: false, reason: 'no_deck' };
  const here = await p.presence.fresh(lock, new Date(now.getTime() - ROOM_PRESENCE_LEASE_MS), PEOPLE_READ_LIMIT);
  if (new Set([...here, owner.accountId]).size < MIN_HERE_TO_START) return { allowed: false, reason: 'few_here' };
  return { allowed: true, deckRitualId: deck.ritualId, deck: deck.payload };
}

/** What the Now strip says of the Launch: one can be started, one is starting or on, or one just finished. */
export async function launchStrip(p: RoomPorts, lock: RoomLock, now: Date): Promise<RoomLaunchStrip | undefined> {
  const latest = await p.launches.latest(lock);
  if (latest !== undefined) {
    const phase = phaseAt(latest.startsAt, now);
    if (latest.state === 'live' && phase.kind === 'lobby') return { state: 'lobby' };
    if (latest.state === 'live' && phase.kind !== 'over') return { state: 'live' };
    if (podiumReadable(overAt(latest), now)) return { state: 'finished' };
  }
  const deck = await p.launches.readyDeck(lock, earliestDeckDay(now), dayOf(now));
  return deck === undefined ? undefined : { state: 'ready' };
}
