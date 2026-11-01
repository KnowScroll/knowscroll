import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type RoomSky } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  CONSTELLATION_POINTS,
  createRoomSky,
  createRoomToday,
  currentConstellation,
  skyLine,
  starsOfCurrent,
  stationCaption,
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
    expect(
      stationCaption(sky({ lit: 7, state: 'named', finished: 1, constellationName: 'The Lantern' }), 'reel'),
    ).toBe('7 of 7 · The Lantern · Reel live');
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
