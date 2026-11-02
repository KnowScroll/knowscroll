import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type RoomSky } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  CONSTELLATION_POINTS,
  FLAIR_HOW,
  FLAIR_WORDS,
  createRoomSky,
  createRoomToday,
  currentConstellation,
  flairProgressWords,
  momentsOfCurrent,
  skyLine,
  starMomentWords,
  starsOfCurrent,
  stationCaption,
  stationMapCaption,
  stationSkyLine,
} from './room-sky';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const ritualId = id(2);
const offline = () => new Error('network');
const refused = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(
  rooms: Api,
  recording: { on: boolean; generation: number } = { on: true, generation: 4 },
): AccountScope & { calls: { name: string; input: unknown }[] } {
  const calls: { name: string; input: unknown }[] = [];
  const wrapped = Object.fromEntries(
    Object.entries(rooms).map(([name, handler]) => [
      name,
      (input: never) => {
        calls.push({ name, input });
        return handler(input);
      },
    ]),
  );
  const session = {
    getState: () => ({ policy: { on: recording.on, generation: recording.generation } }),
    generation: () => Promise.resolve(recording.generation),
    refresh: () => Promise.resolve(true),
  };
  return { active: true, api: { rooms: wrapped }, calls, recording: session } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
  };
}
let counter = 100;
const newId = () => id(counter++);

const sky = (patch: Partial<RoomSky> = {}): RoomSky => ({ lit: 3, of: 7, state: 'forming', finished: 0, ...patch });

describe('the words of the sky', () => {
  it('says how many stars are lit, and names a constellation only when the room has', () => {
    expect(skyLine(sky())).toBe('3 of 7');
    expect(stationSkyLine(sky())).toBe('3 of 7');
    expect(stationSkyLine(sky({ lit: 7, state: 'naming', finished: 1 }))).toBe('7 of 7 · Lit');
    expect(stationSkyLine(sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Lantern' }))).toBe(
      '7 of 7 · The Lantern',
    );
    // The next constellation forming does not take the earned name away, and one waiting for a name is only lit.
    expect(stationSkyLine(sky({ lit: 2, finished: 1, constellationName: 'The Lantern' }))).toBe('2 of 7 · The Lantern');
    expect(stationSkyLine(sky({ lit: 7, state: 'naming', finished: 2, constellationName: 'The Lantern' }))).toBe(
      '7 of 7 · Lit',
    );
  });

  it('has seven points, all inside the box, and one constellation number until the next star starts the next', () => {
    expect(CONSTELLATION_POINTS).toHaveLength(7);
    for (const [x, y] of CONSTELLATION_POINTS) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(1);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(1);
    }
    expect(currentConstellation(sky({ lit: 2, finished: 1 }))).toBe(2);
    expect(currentConstellation(sky({ lit: 7, state: 'naming', finished: 1 }))).toBe(1);
  });

  it('takes the stars of the constellation being made, oldest first', () => {
    const stars = [
      { act: 'daily_solved' as const, day: '2026-10-31', constellation: 2 },
      { act: 'debate_closed' as const, day: '2026-10-30', constellation: 1 },
      { act: 'answer_useful' as const, day: '2026-10-29', constellation: 1 },
    ];
    expect(starsOfCurrent({ sky: sky({ lit: 1, finished: 1 }), stars }).map((star) => star.day)).toEqual([
      '2026-10-31',
    ]);
    expect(
      starsOfCurrent({ sky: sky({ lit: 7, state: 'naming', finished: 1 }), stars }).map((star) => star.day),
    ).toEqual(['2026-10-29', '2026-10-30']);
  });
});

describe('a station caption on the map', () => {
  it('says what is live, a Launch or a Reel, keeping the sky line and the name', () => {
    expect(stationCaption(sky(), 'launch')).toBe('3 of 7 · Launch live');
    expect(stationCaption(sky(), 'reel')).toBe('3 of 7 · Reel live');
    expect(stationCaption(sky(), undefined)).toBe('3 of 7');
    expect(stationCaption(sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Lantern' }), 'reel')).toBe(
      '7 of 7 · The Lantern · Reel live',
    );
  });
});

describe('a station label on the map', () => {
  it('keeps the count and what is live, and drops the constellation name', () => {
    expect(stationMapCaption(sky(), undefined)).toBe('3 of 7');
    expect(
      stationMapCaption(sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Lantern' }), undefined),
    ).toBe('7 of 7');
    expect(stationMapCaption(sky(), 'reel')).toBe('3 of 7 · Reel live');
    expect(stationMapCaption(sky(), 'launch')).toBe('3 of 7 · Launch live');
  });
});

describe('Today on the client', () => {
  const ready = { status: 'ready', roomId, day: '2026-10-31', discussionId: id(3), canPost: true, past: [] };

  it('reads the day and says nothing of why a room is unavailable', async () => {
    let answer: object = ready;
    const controller = createRoomToday({ scope: scopeOf({ today: () => Promise.resolve(answer) }), roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready' });
    answer = { status: 'unavailable' };
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
  });

  it('sends a tap once, reads the day again for the key, and remembers whether it earned the room a star', async () => {
    const scope = scopeOf({
      today: () => Promise.resolve(ready),
      solveFlaw: () => Promise.resolve({ outcome: 'accepted', star: true, correct: true }),
    });
    const controller = createRoomToday({ scope, roomId, newId });
    expect(await controller.solve(ritualId, 2)).toBe(true);
    expect(scope.calls.filter((call) => call.name === 'solveFlaw')).toHaveLength(1);
    expect(scope.calls.find((call) => call.name === 'solveFlaw')?.input).toMatchObject({
      roomId,
      ritualId,
      sentence: 2,
      // The tap carries the generation this device knows, as a call in a Scroll does.
      recordingGeneration: 4,
    });
    expect(scope.calls.some((call) => call.name === 'today')).toBe(true);
    expect(controller.getState().starFor).toBe(ritualId);
  });

  it('retries an unconfirmed tap as the same command, so a tap can never count twice', async () => {
    let attempts = 0;
    const scope = scopeOf({
      today: () => Promise.resolve(ready),
      solveFlaw: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(offline())
          : Promise.resolve({ outcome: 'accepted', star: false, correct: false });
      },
    });
    const controller = createRoomToday({ scope, roomId, newId });
    expect(await controller.solve(ritualId, 1)).toBe(false);
    expect(controller.getState().offline).toBe(true);
    expect(await controller.solve(ritualId, 1)).toBe(true);
    const commands = scope.calls
      .filter((call) => call.name === 'solveFlaw')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(commands[0]).toBe(commands[1]);
    expect(controller.getState().starFor).toBeUndefined();
  });

  it('says a refused tap plainly and reads how the item stands now', async () => {
    const scope = scopeOf({ today: () => Promise.resolve(ready), solveFlaw: () => Promise.reject(refused()) });
    const controller = createRoomToday({ scope, roomId, newId });
    expect(await controller.solve(ritualId, 0)).toBe(false);
    expect(controller.getState().refused).toBe(true);
    expect(scope.calls.some((call) => call.name === 'today')).toBe(true);
  });

  it('sends nothing while recording is paused, and says why', async () => {
    const scope = scopeOf(
      { today: () => Promise.resolve(ready), solveFlaw: () => Promise.reject(new Error('sent')) },
      {
        on: false,
        generation: 5,
      },
    );
    const controller = createRoomToday({ scope, roomId, newId });
    expect(await controller.solve(ritualId, 1)).toBe(false);
    expect(scope.calls.some((call) => call.name === 'solveFlaw')).toBe(false);
    expect(controller.getState().notSaved).toBe('recording_paused');
  });

  it('says so when the server did not keep the tap, and clears the notice on the next tap', async () => {
    let kept = false;
    const scope = scopeOf({
      today: () => Promise.resolve(ready),
      solveFlaw: () =>
        Promise.resolve(
          kept
            ? { outcome: 'accepted', star: false, correct: true }
            : { outcome: 'not_saved', reason: 'recording_generation_stale' },
        ),
    });
    const controller = createRoomToday({ scope, roomId, newId });
    expect(await controller.solve(ritualId, 1)).toBe(false);
    expect(controller.getState().notSaved).toBe('recording_generation_stale');
    expect(controller.getState().starFor).toBeUndefined();
    kept = true;
    expect(await controller.solve(ritualId, 1)).toBe(true);
    expect(controller.getState().notSaved).toBeUndefined();
  });

  it('shows nothing once the account scope has ended', async () => {
    const scope = { ...scopeOf({ today: () => Promise.resolve(ready) }), active: false } as AccountScope;
    const controller = createRoomToday({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState().phase).toBe('loading');
  });
});

describe('the name vote on the client', () => {
  const view = {
    status: 'ready',
    sky: sky({ lit: 7, state: 'naming', finished: 1 }),
    stars: [],
    naming: {
      constellation: 1,
      candidates: ['The Lantern', 'The Kite', 'The Ferry'],
      closesAt: '2026-11-01T08:00:00.000Z',
    },
  };

  it('chooses a name and reads the vote again', async () => {
    const scope = scopeOf({ sky: () => Promise.resolve(view), nameConstellation: () => Promise.resolve({}) });
    const controller = createRoomSky({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready' });
    expect(await controller.name(1, 1)).toBe(true);
    // The vote names the constellation the sheet showed, as well as the place of the name in its list.
    expect(scope.calls.find((call) => call.name === 'nameConstellation')?.input).toMatchObject({
      roomId,
      constellation: 1,
      candidate: 1,
    });
    expect(scope.calls.filter((call) => call.name === 'sky')).toHaveLength(2);
  });

  it('says a refused vote plainly (the vote closed meanwhile) and reads again', async () => {
    const scope = scopeOf({ sky: () => Promise.resolve(view), nameConstellation: () => Promise.reject(refused()) });
    const controller = createRoomSky({ scope, roomId, newId });
    expect(await controller.name(1, 0)).toBe(false);
    expect(controller.getState().refused).toBe(true);
    // A refusal reads the sky again, so the sheet shows the constellation that is open now.
    expect(scope.calls.some((call) => call.name === 'sky')).toBe(true);
  });
});

describe('what earned each star, in words (R3 E5)', () => {
  const asha = {
    kind: 'person' as const,
    personId: id(7),
    handle: 'ci.asha',
    displayName: 'Asha',
  };

  it('names a person only where the server named one, a debate by its title, and a Launch by how many played', () => {
    expect(starMomentWords({ act: 'answer_useful', day: '2026-10-25', constellation: 1, by: asha })).toBe(
      'Asha\u2019s answer marked useful \u00b7 25 Oct',
    );
    expect(starMomentWords({ act: 'answer_useful', day: '2026-10-25', constellation: 1 })).toBe(
      'An answer marked useful \u00b7 25 Oct',
    );
    expect(
      starMomentWords({ act: 'debate_closed', day: '2026-10-24', constellation: 1, title: 'Is Pluto a planet?' }),
    ).toBe('Debate closed: Is Pluto a planet? \u00b7 24 Oct');
    expect(starMomentWords({ act: 'debate_closed', day: '2026-10-24', constellation: 1 })).toBe(
      'Debate closed \u00b7 24 Oct',
    );
    expect(starMomentWords({ act: 'daily_solved', day: '2026-10-23', constellation: 1 })).toBe(
      'Spot the flaw found \u00b7 23 Oct',
    );
    expect(starMomentWords({ act: 'launch_finished', day: '2026-10-26', constellation: 1, played: 5 })).toBe(
      'Launch, 26 Oct \u00b7 5 played',
    );
    expect(starMomentWords({ act: 'launch_finished', day: '2026-10-26', constellation: 1 })).toBe('Launch, 26 Oct');
  });

  it('reads a day in UTC, so a star keeps its day wherever the reader is', () => {
    expect(starMomentWords({ act: 'daily_solved', day: '2026-11-01', constellation: 1 })).toBe(
      'Spot the flaw found \u00b7 1 Nov',
    );
  });

  it('lists the constellation being made, newest first', () => {
    const stars = [
      { act: 'daily_solved' as const, day: '2026-10-31', constellation: 1 },
      { act: 'debate_closed' as const, day: '2026-10-30', constellation: 1 },
      { act: 'answer_useful' as const, day: '2026-10-29', constellation: 1 },
    ];
    expect(momentsOfCurrent({ sky: sky({ lit: 3 }), stars }).map((star) => star.day)).toEqual([
      '2026-10-31',
      '2026-10-30',
      '2026-10-29',
    ]);
    // The view's own list is newest first and is not turned over by the reader.
    expect(stars[0]?.day).toBe('2026-10-31');
  });
});

describe('flair on the client (R3 E5)', () => {
  const card = (patch: object = {}) => ({
    status: 'ready',
    earned: ['first_answer'],
    coming: [{ flair: 'flaw_finder', have: 2, of: 3 }],
    shown: 'first_answer',
    ...patch,
  });
  const skyView = { status: 'ready', sky: sky({ lit: 1 }), stars: [] };

  it('says each mark in fixed words, and how far a partway one is, with the server\u2019s number', () => {
    expect(FLAIR_WORDS).toEqual({
      first_answer: 'First answer',
      good_question: 'Good question',
      flaw_finder: 'Flaw finder',
      launch_regular: 'Launch regular',
    });
    expect(Object.keys(FLAIR_HOW)).toEqual(Object.keys(FLAIR_WORDS));
    expect(flairProgressWords({ flair: 'flaw_finder', have: 2, of: 3 })).toBe('Flaw finder \u00b7 2/3');
  });

  it('reads the card with the sky, and a card that cannot be read leaves the sky', async () => {
    const scope = scopeOf({ sky: () => Promise.resolve(skyView), flair: () => Promise.resolve(card()) });
    const controller = createRoomSky({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', flair: { earned: ['first_answer'] } });
    const broken = scopeOf({ sky: () => Promise.resolve(skyView), flair: () => Promise.reject(offline()) });
    const alone = createRoomSky({ scope: broken, roomId, newId });
    await alone.load();
    expect(alone.getState().phase).toBe('ready');
    expect(alone.getState().flair).toBeUndefined();
  });

  it('shows no card for a room that is unavailable', async () => {
    const scope = scopeOf({
      sky: () => Promise.resolve({ status: 'unavailable' }),
      flair: () => Promise.resolve({ status: 'unavailable' }),
    });
    const controller = createRoomSky({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', flair: undefined });
  });

  it('chooses what shows and reads the card again, as the same command if it has to be sent twice', async () => {
    let shown: string | undefined = 'first_answer';
    let failing = true;
    const scope = scopeOf({
      sky: () => Promise.resolve(skyView),
      flair: () => Promise.resolve(card({ ...(shown === undefined ? { shown: undefined } : { shown }) })),
      chooseFlair: () => {
        if (failing) return Promise.reject(offline());
        shown = undefined;
        return Promise.resolve({});
      },
    });
    const controller = createRoomSky({ scope, roomId, newId });
    await controller.load();
    expect(await controller.chooseFlair('none')).toBe(false);
    failing = false;
    expect(await controller.chooseFlair('none')).toBe(true);
    const sent = scope.calls
      .filter((call) => call.name === 'chooseFlair')
      .map((call) => call.input as { commandId: string; flair: string });
    expect(sent.map((call) => call.flair)).toEqual(['none', 'none']);
    expect(sent[0]!.commandId).toBe(sent[1]!.commandId);
    expect(controller.getState().flair?.shown).toBeUndefined();
  });

  it('says a refused choice plainly by reading the card again', async () => {
    const scope = scopeOf({
      sky: () => Promise.resolve(skyView),
      flair: () => Promise.resolve(card()),
      chooseFlair: () => Promise.reject(refused()),
    });
    const controller = createRoomSky({ scope, roomId, newId });
    await controller.load();
    expect(await controller.chooseFlair('launch_regular')).toBe(false);
    expect(scope.calls.filter((call) => call.name === 'flair')).toHaveLength(2);
  });
});
