import type { Page } from '@playwright/test';
import { LAUNCH_HOST } from '@knowscroll/contracts';
import { id } from './encounter-fixture';

/**
 * The Launch (v3 R-6) over labelled HTTP fixtures, for two people at once. The `LaunchWorld` is the one room both are in and it keeps
 * the server's rules in a test's own words: one clock decides every phase, a question reaches a reader only while it is open, its
 * key only after it closes, an answer is judged by when the world received it, and the Launch is settled by whichever device says it
 * is over. The timings are shorter than the product's (a few seconds, not twenty and eight) so a whole game fits in one test; the
 * screen counts whatever time the view carries. Authored people and questions: never product data, never a model's words.
 */
export const TIMING = { lobbyMs: 3_000, answerMs: 5_000, revealMs: 2_000 } as const;
const ROUND = TIMING.answerMs + TIMING.revealMs;
const QUESTIONS = 5;
const launchId = id(900);

/** A viewer of the room: the fixture's two people. */
export type Who = 'ravi' | 'asha';
const PEOPLE = {
  ravi: { kind: 'person' as const, personId: id(10), handle: 'ci.ravi', displayName: 'Ravi' },
  asha: { kind: 'person' as const, personId: id(11), handle: 'ci.asha', displayName: 'Asha' },
};

/** Five authored questions: the options and the right one, and a reason that is shown only after the question closes. */
export const DECK = [
  {
    prompt: 'Sunlight reaches Earth in about…',
    options: ['8 seconds', '8 minutes', '8 hours'],
    answer: 1,
    explain: 'Light takes about eight minutes to cross the gap.',
  },
  {
    prompt: 'Which is bigger, the Sun or Betelgeuse?',
    options: ['The Sun', 'Betelgeuse'],
    answer: 1,
    explain: 'Betelgeuse is a red supergiant, hundreds of times wider.',
  },
  {
    prompt: 'What makes the seasons?',
    options: ['Distance from the Sun', 'The tilt of the axis', 'The Moon'],
    answer: 1,
    explain: 'The tilt changes how directly sunlight lands.',
  },
  {
    prompt: 'The Moon turns on its axis…',
    options: ['Once an orbit', 'Never'],
    answer: 0,
    explain: 'One turn per orbit keeps one face toward us.',
  },
  {
    prompt: 'A light-year measures…',
    options: ['Time', 'Distance', 'Brightness'],
    answer: 1,
    explain: 'It is the distance light travels in a year.',
  },
] as const;

type Phase =
  | { kind: 'none' }
  | { kind: 'lobby'; left: number }
  | { kind: 'open'; round: number; left: number }
  | { kind: 'reveal'; round: number; left: number }
  | { kind: 'over' };

export class LaunchWorld {
  /** Stars the room has earned in all (a settled Launch with two players adds one). */
  stars: number;
  startsAt: number | undefined;
  settled = false;
  star = false;
  readonly players = new Map<Who, number>();
  readonly answers = new Map<string, { choice: number; elapsedMs: number }>();
  /** What was posted into General from a podium. */
  readonly posts: { who: Who; text: string }[] = [];
  readonly calls: { who: Who; path: string; body: Record<string, unknown> }[] = [];

  constructor(starsBefore = 5) {
    this.stars = starsBefore;
  }

  phase(now = Date.now()): Phase {
    if (this.startsAt === undefined) return { kind: 'none' };
    const since = now - this.startsAt;
    if (since < 0) return { kind: 'lobby', left: -since };
    if (since >= QUESTIONS * ROUND) return { kind: 'over' };
    const round = Math.floor(since / ROUND) + 1;
    const into = since % ROUND;
    return into < TIMING.answerMs
      ? { kind: 'open', round, left: TIMING.answerMs - into }
      : { kind: 'reveal', round, left: ROUND - into };
  }

  /** The room view's own word for the Launch: nothing, ready, starting, on, or just finished. */
  strip(): { state: 'ready' | 'lobby' | 'live' | 'finished' } {
    const phase = this.phase();
    if (phase.kind === 'none') return { state: 'ready' };
    if (phase.kind === 'lobby') return { state: 'lobby' };
    return phase.kind === 'over' ? { state: 'finished' } : { state: 'live' };
  }

  start(who: Who): number {
    this.startsAt = Date.now() + TIMING.lobbyMs;
    this.players.set(who, Date.now());
    return TIMING.lobbyMs;
  }

  answer(who: Who, round: number, choice: number): boolean {
    const phase = this.phase();
    if (phase.kind !== 'open' || phase.round !== round) return false;
    this.players.set(who, this.players.get(who) ?? Date.now());
    const key = `${who}:${String(round)}`;
    if (!this.answers.has(key)) this.answers.set(key, { choice, elapsedMs: TIMING.answerMs - phase.left });
    return true;
  }

  /** Settles the Launch when its time has passed: once, with the star when two people answered. */
  finish(): void {
    if (this.settled || this.phase().kind !== 'over') return;
    this.settled = true;
    const played = new Set([...this.answers.keys()].map((key) => key.split(':')[0]));
    this.star = played.size >= 2;
    if (this.star) this.stars += 1;
  }

  private results() {
    return [...this.players.keys()]
      .map((who) => {
        const rights = DECK.flatMap((question, index) => {
          const answer = this.answers.get(`${who}:${String(index + 1)}`);
          return answer?.choice === question.answer ? [{ round: index + 1, elapsedMs: answer.elapsedMs }] : [];
        });
        return {
          who,
          score: rights.length,
          totalMs: rights.reduce((sum, right) => sum + right.elapsedMs, 0),
          squares: DECK.map((_, index) => rights.some((right) => right.round === index + 1)),
        };
      })
      .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs);
  }

  /** The Launch as `viewer` reads it now, in the contract's own shape. */
  view(viewer: Who): Record<string, unknown> | undefined {
    const phase = this.phase();
    const youIn = this.players.has(viewer);
    const face = (who: Who) => ({ person: PEOPLE[who], you: who === viewer });
    if (phase.kind === 'none') return undefined;
    if (phase.kind === 'lobby')
      return {
        phase: 'lobby',
        launchId,
        startsInMs: phase.left,
        players: [...this.players.keys()].sort((a) => (a === viewer ? -1 : 1)).map(face),
        youIn,
      };
    if (phase.kind === 'over') {
      const results = this.results();
      const podium = results
        .filter((result) => result.score > 0)
        .slice(0, 3)
        .map((result, index) => ({
          place: index + 1,
          score: result.score,
          person: PEOPLE[result.who],
          blockedByYou: false,
          you: result.who === viewer,
        }));
      const own = results.find((result) => result.who === viewer);
      return {
        phase: 'finished',
        launchId,
        played: new Set([...this.answers.keys()].map((key) => key.split(':')[0])).size,
        podium,
        ...(own === undefined
          ? {}
          : {
              you: {
                score: own.score,
                squares: own.squares,
                ...(podium.find((entry) => entry.you) === undefined
                  ? {}
                  : { place: podium.find((entry) => entry.you)!.place }),
              },
            }),
        star: this.star,
        day: '2026-10-26',
        youIn,
      };
    }
    const question = DECK[phase.round - 1]!;
    const mine = this.answers.get(`${viewer}:${String(phase.round)}`);
    const common = {
      launchId,
      round: phase.round,
      of: 5,
      prompt: question.prompt,
      options: question.options,
      ...(mine === undefined ? {} : { yourChoice: mine.choice }),
      youIn,
    };
    if (phase.kind === 'open') return { phase: 'open', ...common, closesInMs: phase.left };
    const answered = [...this.players.keys()].filter((who) => this.answers.has(`${who}:${String(phase.round)}`));
    const right = answered.filter(
      (who) => this.answers.get(`${who}:${String(phase.round)}`)!.choice === question.answer,
    );
    return {
      phase: 'reveal',
      ...common,
      correct: question.answer,
      explain: question.explain,
      locked: answered.length,
      right: right.length,
      calledIt: right.map(face),
      yourScore: DECK.slice(0, phase.round).filter(
        (q, index) => this.answers.get(`${viewer}:${String(index + 1)}`)?.choice === q.answer,
      ).length,
      nextInMs: phase.left,
      last: phase.round === QUESTIONS,
      youIn,
    };
  }
}

const receipt = (body: Record<string, unknown>, scope: unknown, operation: string) => ({
  version: 'rooms.v1',
  scope,
  commandId: body['commandId'],
  recordedAt: new Date().toISOString(),
  replayed: false,
  outcome: 'accepted',
  operation,
  roomId: body['roomId'],
});

/**
 * Answers the Launch routes (and the share into General) for one person. Register it after `roomFixture`: its routes are matched
 * first and everything else falls through to the room's own fixture.
 */
export async function launchRoutes(
  page: Page,
  world: LaunchWorld,
  who: Who,
  scope: { accountId: string; privacyEpoch: number },
) {
  await page.route('**/v1/rooms/launch/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    world.calls.push({ who, path, body });
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path.endsWith('/read')) {
      const launch = world.view(who);
      const finished = launch?.['phase'] === 'finished';
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          host: LAUNCH_HOST,
          ...(launch === undefined ? {} : { launch }),
          ...(launch === undefined
            ? { start: { allowed: true } }
            : finished
              ? { start: { allowed: false, reason: 'resting' } }
              : {}),
        },
      });
    }
    if (path.endsWith('/start')) {
      const startsInMs = world.start(who);
      return route.fulfill({ json: { ...receipt(body, scope, 'launch.start'), launchId, startsInMs } });
    }
    if (path.endsWith('/join')) {
      world.players.set(who, world.players.get(who) ?? Date.now());
      return route.fulfill({ json: { ...receipt(body, scope, 'launch.join'), launchId } });
    }
    if (path.endsWith('/answer')) {
      const kept = world.answer(who, body['round'] as number, body['choice'] as number);
      if (!kept)
        return route.fulfill({
          status: 403,
          json: { type: 'about:blank', title: 'Unavailable', status: 403, code: 'SHARING_UNAVAILABLE' },
        });
      return route.fulfill({ json: { ...receipt(body, scope, 'launch.answer'), launchId, round: body['round'] } });
    }
    if (path.endsWith('/finish')) {
      world.finish();
      return route.fulfill({ json: { ...receipt(body, scope, 'launch.finish'), launchId } });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  // The share card into General: recorded, so a test can see exactly what was posted (squares only).
  await page.route('**/v1/rooms/discussions/send', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const text = (body['body'] as { text?: string } | undefined)?.text;
    if (text === undefined) return route.fallback();
    world.posts.push({ who, text });
    return route.fulfill({
      json: {
        ...receipt(body, scope, 'discussion.send'),
        discussionId: body['discussionId'],
        messageId: id(901),
        messageSequence: 9,
      },
    });
  });
}
