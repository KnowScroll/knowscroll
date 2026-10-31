import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { LAUNCH_HOST, problemDetails, type ReplayRound } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  REPLAY_ANSWER_MS,
  createRoomReplay,
  replayBanner,
  replayChip,
  replayCountLine,
  replayHostLine,
  replayPlaceLine,
  replayScoreLine,
  type ReplayData,
} from './room-replay';

const id = (n: number) => `0199e000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const launchId = id(2);
const refused = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(rooms: Api) {
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
  return { active: true, api: { rooms: wrapped }, calls } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
  };
}
let counter = 100;
const newId = () => id(counter++);

const person = { kind: 'person' as const, personId: id(9), handle: 'kenji', displayName: 'Kenji' };
const replay: ReplayData = {
  launchId,
  day: '2026-10-26',
  played: 5,
  questions: [1, 2, 3, 4, 5].map((round) => ({
    round,
    prompt: `Question ${String(round)}?`,
    options: ['The Sun', 'Betelgeuse'],
  })),
  answerSeconds: 8,
};
const readyRead = (data?: ReplayData) => ({
  status: 'ready',
  readId: id(7),
  host: LAUNCH_HOST,
  ...(data === undefined ? {} : { replay: data }),
});
const answerOf = (
  over: Partial<Extract<ReplayRound, { status: 'ready' }>> = {},
): Extract<ReplayRound, { status: 'ready' }> => ({
  status: 'ready',
  version: 'rooms.v1',
  readId: id(7),
  scope: { accountId: id(2), privacyEpoch: 1 },
  launchId,
  round: 1,
  correct: 1,
  explain: 'Betelgeuse is a red supergiant.',
  locked: 5,
  right: 3,
  calledIt: [{ person, you: false }],
  ...over,
});

describe('what a replay says', () => {
  it('says what it is on every screen: the night, how many played, that nothing is saved', () => {
    const words = replayBanner(replay);
    expect(words).toContain('Replay.');
    expect(words).toContain('26 Oct');
    expect(words).toContain('the 5 people who played');
    expect(words).toContain('nothing is saved');
    expect(replayBanner({ ...replay, played: 1 })).toContain('the one person who played');
  });

  it('names the night in the chip and never says "last night", which a UTC day cannot promise', () => {
    expect(replayChip({ day: '2026-10-26' })).toEqual({ label: 'Replay', detail: 'Launch of 26 Oct' });
    expect(replayChip(undefined)).toBeUndefined();
  });

  it('counts how many called it with no blame, and says so when nobody answered', () => {
    expect(replayCountLine(answerOf())).toBe('3 of 5 called it');
    expect(replayCountLine(answerOf({ locked: 0, right: 0, calledIt: [] }))).toBe('Nobody answered this one.');
  });

  it('gives a place only to a right answer with a time, and says nothing of a wrong one', () => {
    expect(replayPlaceLine(answerOf({ quicker: 1 }), 1)).toBe('You’d have been 2nd fastest.');
    expect(replayPlaceLine(answerOf({ quicker: 0 }), 1)).toBe('You’d have been the fastest.');
    expect(replayPlaceLine(answerOf({ quicker: 2 }), 1)).toBe('You’d have been 3rd fastest.');
    expect(replayPlaceLine(answerOf({ quicker: 3 }), 1)).toBe('You’d have been 4th fastest.');
    expect(replayPlaceLine(answerOf({ quicker: 1 }), 0)).toBeUndefined();
    expect(replayPlaceLine(answerOf({ quicker: 1 }), undefined)).toBeUndefined();
    expect(replayPlaceLine(answerOf(), 1)).toBeUndefined();
    expect(replayPlaceLine(answerOf({ right: 0, locked: 0, calledIt: [], quicker: 0 }), 1)).toBe(
      'Nobody else got this one.',
    );
  });

  it('writes the score with the squares of a share card, which hold no answer', () => {
    expect(replayScoreLine([true, true, false, true, false])).toBe('You’d have got 3 of 5 · ■■□■□');
  });

  it('lets the host speak template lines, with a plot twist and never a blame', () => {
    const host = { name: LAUNCH_HOST.name };
    expect(replayHostLine(host, 'idle', 0, undefined)).toContain('Pixel here');
    expect(replayHostLine(host, 'asking', 0, undefined)).toBe('Question 1. Go.');
    expect(replayHostLine(host, 'asking', 4, undefined)).toBe('Last question. Go.');
    expect(replayHostLine(host, 'revealed', 1, { picked: 1, correct: 1 })).toBe('Called it!');
    expect(replayHostLine(host, 'revealed', 1, { picked: 0, correct: 1 })).toBe('Plot twist.');
    expect(replayHostLine(host, 'revealed', 1, { picked: undefined, correct: 1 })).toBe('Time’s up on that one.');
    expect(replayHostLine(host, 'done', 4, undefined)).toBe('That’s the replay.');
  });
});

describe('playing a replay', () => {
  function playing(rooms: Api, start = 1_000) {
    let now = start;
    const scope = scopeOf(rooms);
    const controller = createRoomReplay({ scope, roomId, newId, clock: () => now });
    return { scope, controller, tick: (ms: number) => void (now += ms) };
  }

  it('reads what can be replayed and keeps nothing about the person', async () => {
    const { controller, scope } = playing({ replay: () => Promise.resolve(readyRead(replay)) });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', host: LAUNCH_HOST, step: 'idle', replay });
    expect(scope.calls.map((call) => call.name)).toEqual(['replay']);
    expect(scope.calls[0]?.input).toMatchObject({ version: 'rooms.v1', roomId });
  });

  it('shows nothing to replay when the server says there is none, and nothing at all when it says unavailable', async () => {
    const none = playing({ replay: () => Promise.resolve(readyRead()) });
    await none.controller.load();
    expect(none.controller.getState()).toMatchObject({ phase: 'ready', replay: undefined });
    const gone = playing({ replay: () => Promise.reject(refused()) });
    await gone.controller.load();
    expect(gone.controller.getState().phase).toBe('unavailable');
  });

  it('sends the choice and this device’s own steady-clock time, and shows the key it gets back', async () => {
    const { controller, scope, tick } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => Promise.resolve(answerOf({ quicker: 1 })),
    });
    await controller.load();
    controller.begin();
    expect(controller.getState()).toMatchObject({ step: 'asking', index: 0, shownAt: 1_000 });
    tick(3_400);
    await controller.pick(1);
    expect(scope.calls.at(-1)).toMatchObject({
      name: 'replayRound',
      input: { version: 'rooms.v1', roomId, launchId, round: 1, choice: 1, elapsedMs: 3_400 },
    });
    expect(controller.getState()).toMatchObject({ step: 'revealed', picked: 1, squares: [true] });
    expect(controller.getState().answer?.correct).toBe(1);
  });

  it('counts a time over eight seconds as eight, and a second tap changes nothing', async () => {
    const { controller, scope, tick } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => Promise.resolve(answerOf()),
    });
    await controller.load();
    controller.begin();
    tick(60_000);
    await controller.pick(0);
    await controller.pick(1);
    const sent = scope.calls.filter((call) => call.name === 'replayRound');
    expect(sent).toHaveLength(1);
    expect((sent[0]?.input as { elapsedMs: number }).elapsedMs).toBe(REPLAY_ANSWER_MS);
    expect(controller.getState()).toMatchObject({ picked: 0, squares: [false] });
  });

  it('shows the key with no choice when the time runs out, and scores it as missed', async () => {
    const { controller, scope } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => Promise.resolve(answerOf()),
    });
    await controller.load();
    controller.begin();
    await controller.timeUp();
    const input = scope.calls.at(-1)?.input as Record<string, unknown>;
    expect(input).not.toHaveProperty('choice');
    expect(input).not.toHaveProperty('elapsedMs');
    expect(controller.getState()).toMatchObject({ step: 'revealed', picked: undefined, squares: [false] });
  });

  it('goes through five questions to the end and back to the start when the person leaves', async () => {
    let round = 0;
    const { controller } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => Promise.resolve(answerOf({ round: ++round, correct: 1 })),
    });
    await controller.load();
    controller.begin();
    for (let index = 0; index < 5; index++) {
      expect(controller.getState()).toMatchObject({ step: 'asking', index });
      await controller.pick(index % 2);
      controller.next();
    }
    expect(controller.getState()).toMatchObject({ step: 'done', squares: [false, true, false, true, false] });
    controller.leave();
    expect(controller.getState()).toMatchObject({ step: 'idle', index: 0, squares: [] });
  });

  it('puts the question back when the connection is lost, so the same tap can be sent again', async () => {
    let up = false;
    const { controller } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => (up ? Promise.resolve(answerOf()) : Promise.reject(new Error('network'))),
    });
    await controller.load();
    controller.begin();
    await controller.pick(1);
    expect(controller.getState()).toMatchObject({ step: 'asking', picked: undefined, offline: true, working: false });
    up = true;
    await controller.pick(1);
    expect(controller.getState()).toMatchObject({ step: 'revealed', offline: false });
  });

  it('ends the replay when the server no longer offers it', async () => {
    const { controller } = playing({
      replay: () => Promise.resolve(readyRead(replay)),
      replayRound: () => Promise.reject(refused()),
    });
    await controller.load();
    controller.begin();
    await controller.pick(1);
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', step: 'idle', replay: undefined });
  });

  it('starts over when a read finds another Launch to replay than the one in hand', async () => {
    let next: ReplayData | undefined = replay;
    const { controller } = playing({
      replay: () => Promise.resolve(readyRead(next)),
      replayRound: () => Promise.resolve(answerOf()),
    });
    await controller.load();
    controller.begin();
    await controller.pick(1);
    next = { ...replay, launchId: id(3) };
    await controller.load();
    expect(controller.getState()).toMatchObject({ step: 'idle', squares: [], replay: { launchId: id(3) } });
  });
});
