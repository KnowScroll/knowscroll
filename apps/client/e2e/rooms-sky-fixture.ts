import type { Page } from '@playwright/test';
import { id } from './encounter-fixture';

/**
 * Today and the sky (v3 R-5) over labelled HTTP fixtures, for two people at once. The `SkyWorld` is the one room both of
 * them are in: when person A taps the right sentence the world earns a star, so person C's map and room read the same sky.
 * Authored names, sentences and questions; never product data and never a model's words.
 */
export const todayId = id(520);
export const flawId = id(521);
const questionId = id(522);
const scrollId = id(523);
const NAMES = ['The Lantern', 'The Kite', 'The Ferry'] as const;

/** The room as the fixture keeps it. Changing `stars` changes what every person's read says. */
export interface SkyWorld {
  /** Stars the room has earned in all, as the server counts them. */
  stars: number;
  /** The index A tapped on Spot the flaw, once they have. */
  picked: number | undefined;
  /** Which name each person chose, by account (only the reader's own is ever sent back). */
  vote: number | undefined;
  /** The name the room settled on, once the vote closed. */
  named: string | undefined;
  readonly solves: { sentence: number }[];
}

export const skyWorld = (stars: number): SkyWorld => ({
  stars,
  picked: undefined,
  vote: undefined,
  named: undefined,
  solves: [],
});

/** The sky as every read of the room carries it, worked out from the star count by the rule the server uses. */
export function skyOf(world: SkyWorld) {
  const finished = Math.floor(world.stars / 7);
  const lit = world.stars === 0 ? 0 : ((world.stars - 1) % 7) + 1;
  const full = lit === 7;
  return {
    lit,
    of: 7,
    state: !full ? 'forming' : world.named === undefined ? 'naming' : 'named',
    finished,
    ...(world.named === undefined ? {} : { constellationName: world.named }),
  };
}

const person = (n: number, name: string) => ({
  kind: 'person' as const,
  personId: id(10 + n),
  handle: `ci.${name.toLowerCase()}`,
  displayName: name,
});
const SOURCE = {
  status: 'available' as const,
  target: { assetId: scrollId, assetRevision: 1 },
  metadata: {
    kind: 'scroll' as const,
    title: 'Why the Moon shows one face',
    summary: 'Tidal locking.',
    language: 'en',
  },
};
const nova = { kind: 'ai' as const, inhabitant: 'explainer' as const, name: 'Nova', label: 'AI · Explainer' };
const halley = { kind: 'ai' as const, inhabitant: 'skeptic' as const, name: 'Halley', label: 'AI · Skeptic' };
const SENTENCES = [
  'The Moon always shows us the same face.',
  'That is because it turns once on its axis for every orbit around Earth.',
  'Its far side is a dark side that never gets sunlight.',
  'Earth’s pull locked it into that rhythm long ago.',
];
const FLAW_INDEX = 2;
const ORIGINAL = 'Its far side gets as much sunlight as the side we see.';

/** What the room view says of today when the fixture's operator approved both items. */
export const TODAY_STRIP = { discussionId: todayId, prompt: 'Why is the night sky dark?', flaw: true } as const;

const receipt = (body: Record<string, unknown>, scope: unknown, operation: string) => ({
  version: 'rooms.v1',
  scope,
  commandId: body['commandId'],
  recordedAt: new Date().toISOString(),
  replayed: false,
  outcome: 'accepted',
  operation,
});

/** The calls a person's screen made to the sky routes, so a test can see what was sent (and what was not). */
export interface SkyCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * Answers Today, the sky, the debate vote and the Today discussion for one person. Register it after `roomFixture`: its
 * routes are matched first and everything else falls through to the room's own fixture.
 */
export async function skyRoutes(page: Page, world: SkyWorld, scope: { accountId: string; privacyEpoch: number }) {
  const calls: SkyCall[] = [];
  await page.route('**/v1/rooms/{today,sky,debates}/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    const base = { version: 'rooms.v1', readId: body['readId'], scope };
    if (path === '/v1/rooms/today/read')
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          day: '2026-10-27',
          discussionId: todayId,
          canPost: true,
          question: {
            ritualId: questionId,
            prompt: 'Why is the night sky dark?',
            detail: 'If the universe is full of stars, why is not every direction bright?',
            by: nova,
            source: SOURCE,
            answers: 0,
          },
          flaw:
            world.picked === undefined
              ? { state: 'open', ritualId: flawId, by: halley, sentences: SENTENCES }
              : {
                  state: 'done',
                  ritualId: flawId,
                  by: halley,
                  sentences: SENTENCES,
                  yourPick: world.picked,
                  correct: world.picked === FLAW_INDEX,
                  flawIndex: FLAW_INDEX,
                  original: ORIGINAL,
                  source: SOURCE,
                  found: world.solves.filter((solve) => solve.sentence === FLAW_INDEX).length,
                },
          past: [{ day: '2026-10-26', prompt: 'Is Pluto a planet?' }],
        },
      });
    if (path === '/v1/rooms/today/solve') {
      const sentence = body['sentence'] as number;
      const first = world.picked === undefined;
      world.picked ??= sentence;
      if (first) world.solves.push({ sentence });
      // The first right tap of the day earns the room a star (the server's rule, kept here only to feed the two views).
      const star = first && sentence === FLAW_INDEX;
      if (star) world.stars += 1;
      return route.fulfill({
        json: {
          ...receipt(body, scope, 'today.solve'),
          roomId: body['roomId'],
          ritualId: body['ritualId'],
          correct: sentence === FLAW_INDEX,
          flawIndex: FLAW_INDEX,
          original: ORIGINAL,
          star,
        },
      });
    }
    if (path === '/v1/rooms/sky/read') {
      const naming = skyOf(world).state === 'naming';
      return route.fulfill({
        json: {
          ...base,
          status: 'ready',
          sky: skyOf(world),
          stars: Array.from({ length: Math.min(world.stars, 28) }, (_, index) => ({
            act: (['answer_useful', 'debate_closed', 'daily_solved'] as const)[index % 3],
            day: `2026-10-${String(27 - index).padStart(2, '0')}`,
            constellation: Math.floor((world.stars - 1 - index) / 7) + 1,
          })),
          ...(naming
            ? {
                naming: {
                  constellation: Math.floor(world.stars / 7),
                  candidates: NAMES,
                  closesAt: '2026-10-28T08:00:00.000Z',
                  ...(world.vote === undefined
                    ? {}
                    : { yourVote: world.vote, votes: NAMES.map((_, i) => (i === world.vote ? 1 : 0)) }),
                },
              }
            : {}),
        },
      });
    }
    if (path === '/v1/rooms/sky/name') {
      world.vote = body['candidate'] as number;
      return route.fulfill({
        json: { ...receipt(body, scope, 'sky.name'), roomId: body['roomId'], candidate: body['candidate'] },
      });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });
  // Today's discussion: an empty channel with a few answers the day's people gave.
  await page.route('**/v1/rooms/discussions/read', (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    if (body['discussionId'] !== todayId) return route.fallback();
    const asha = person(1, 'Asha');
    return route.fulfill({
      json: {
        version: 'rooms.v1',
        readId: body['readId'],
        scope,
        status: 'ready',
        room: {
          roomId: body['roomId'],
          name: 'Space room',
          description: 'x',
          topic: { kind: 'system', id: 'astronomy', label: 'Astronomy' },
          joinRule: 'open',
          status: 'open',
        },
        role: 'member',
        you: person(0, 'Ravi'),
        discussion: { discussionId: todayId, kind: 'today', title: 'Today', pinned: false },
        canPost: true,
        inhabitants: [],
        latestMessageSequence: 1,
        messages: [
          {
            messageId: id(700),
            sequence: 1,
            status: 'available',
            author: asha,
            recordedAt: new Date().toISOString(),
            body: {
              kind: 'text',
              text: 'Because the universe has a beginning, so the light from far stars has not arrived yet.',
            },
          },
        ],
        limit: body['limit'],
        history: { kind: 'end' },
        catchUpCursor: `krc1_${'A'.repeat(25)}1`,
      },
    });
  });
  return { calls };
}
