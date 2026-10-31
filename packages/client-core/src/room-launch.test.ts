import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, LAUNCH_HOST, type LaunchView } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  START_BLOCK_WORDS,
  createRoomLaunch,
  hostLine,
  launchChip,
  launchDayWords,
  launchStripOf,
  launchShareText,
  msUntilNextRead,
  secondsLeft,
  squaresOf,
  timeLeftMs,
} from './room-launch';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const launchId = id(2);
const offline = () => new Error('network');
const refused = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(rooms: Api, recording: { on: boolean; generation: number } = { on: true, generation: 4 }) {
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
  const listeners = new Set<() => void>();
  const session = {
    getState: () => ({ policy: { on: recording.on, generation: recording.generation } }),
    generation: () => Promise.resolve(recording.generation),
    refresh: () => Promise.resolve(true),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** A test turns recording off or on, as the Privacy screen does, and the session tells whoever listens. */
    change: (on: boolean) => {
      recording.on = on;
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
  return { active: true, api: { rooms: wrapped }, calls, recording: session } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
    recording: typeof session;
  };
}
let counter = 100;
const newId = () => id(counter++);

const person = { kind: 'person' as const, personId: id(9), handle: 'asha', displayName: 'Asha' };
const question = { launchId, round: 2, of: 5 as const, prompt: 'Which is bigger?', options: ['The Sun', 'Betelgeuse'] };
const lobby: LaunchView = {
  phase: 'lobby',
  launchId,
  startsInMs: 12_000,
  players: [{ person, you: true }],
  youIn: true,
};
const open: LaunchView = { phase: 'open', ...question, closesInMs: 6_500, youIn: false };
const reveal: LaunchView = {
  phase: 'reveal',
  ...question,
  correct: 1,
  explain: 'Betelgeuse is a red supergiant.',
  locked: 2,
  right: 1,
  calledIt: [{ person, you: true }],
  yourScore: 1,
  nextInMs: 4_000,
  last: false,
  youIn: true,
};
const podium: LaunchView = {
  phase: 'finished',
  launchId,
  played: 2,
  podium: [{ place: 1, score: 3, person, blockedByYou: false, you: true }],
  you: { score: 3, squares: [true, true, false, true, false], place: 1 },
  star: false,
  day: '2026-10-26',
  youIn: true,
};
const ready = (launch?: LaunchView) => ({
  status: 'ready',
  readId: id(7),
  host: LAUNCH_HOST,
  ...(launch === undefined ? {} : { launch }),
});

describe('time on a Launch screen counts the server’s milliseconds, not the device’s date', () => {
  it('counts down from the time left that the view carried, by the steady clock since it arrived', () => {
    expect(timeLeftMs(lobby, 0)).toBe(12_000);
    expect(timeLeftMs(open, 2_000)).toBe(4_500);
    expect(timeLeftMs(reveal, 9_000)).toBe(0);
    expect(timeLeftMs(podium, 0)).toBeUndefined();
    expect(secondsLeft(8_000)).toBe(8);
    expect(secondsLeft(7_001)).toBe(8);
    expect(secondsLeft(1)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
  });

  it('reads again just after the phase it shows has ended, and never for a podium or an empty room', () => {
    expect(msUntilNextRead(open, 1_000)).toBe(5_650);
    expect(msUntilNextRead(open, 60_000)).toBe(150);
    expect(msUntilNextRead(podium, 0)).toBeUndefined();
    expect(msUntilNextRead(undefined, 0)).toBeUndefined();
  });
});

describe('the words of a Launch', () => {
  it('writes the share card as a row of squares with no question and no answer in it', () => {
    const text = launchShareText({
      roomName: 'Space room',
      when: launchDayWords('2026-10-26'),
      squares: [true, true, true, false, true],
    });
    expect(text).toBe('Space room · Launch 26 Oct · 4/5\n■■■□■');
    expect(squaresOf([false, false, false, false, false])).toBe('□□□□□');
    expect(launchDayWords('2026-01-03')).toBe('3 Jan');
  });

  it('has the host speak template lines by the state of the game, never of a wrong answer', () => {
    const lines = [
      hostLine(lobby, LAUNCH_HOST),
      hostLine({ ...lobby, youIn: false }, LAUNCH_HOST),
      hostLine(open, LAUNCH_HOST),
      hostLine({ ...open, round: 1 }, LAUNCH_HOST),
      hostLine({ ...open, round: 5 }, LAUNCH_HOST),
      hostLine({ ...reveal, yourChoice: 1 }, LAUNCH_HOST),
      hostLine({ ...reveal, yourChoice: 0 }, LAUNCH_HOST),
      hostLine({ ...reveal, last: true }, LAUNCH_HOST),
      hostLine(podium, LAUNCH_HOST),
    ];
    expect(lines).toContain('Called it!');
    expect(lines).toContain('Question one. Eight seconds, go.');
    expect(lines).toContain('Last question. Go.');
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect(line).not.toMatch(/wrong|incorrect|fail|lose|lost|bad/i);
  });

  it('takes the strip word from the Launch it last read, and the room own when it has read none', () => {
    expect(launchStripOf(lobby, { state: 'ready' })).toEqual({ state: 'lobby' });
    expect(launchStripOf(open, { state: 'lobby' })).toEqual({ state: 'live' });
    expect(launchStripOf(reveal, undefined)).toEqual({ state: 'live' });
    expect(launchStripOf(podium, { state: 'live' })).toEqual({ state: 'finished' });
    expect(launchStripOf(undefined, { state: 'ready' })).toEqual({ state: 'ready' });
    expect(launchStripOf(undefined, undefined)).toBeUndefined();
  });

  it('says why a Launch cannot start, and what the chip offers for each state', () => {
    for (const reason of Object.keys(START_BLOCK_WORDS) as (keyof typeof START_BLOCK_WORDS)[])
      expect(START_BLOCK_WORDS[reason].length).toBeGreaterThan(10);
    expect(launchChip(undefined)).toBeUndefined();
    expect(launchChip({ state: 'ready' })).toMatchObject({ detail: 'Start a quiz', live: false });
    expect(launchChip({ state: 'lobby' })).toMatchObject({ live: true });
    expect(launchChip({ state: 'live' })).toMatchObject({ detail: 'Live now', live: true });
    expect(launchChip({ state: 'finished' })).toMatchObject({ detail: 'Podium', live: false });
  });
});

describe('a Launch on the client', () => {
  it('reads the Launch and says nothing of why a room is unavailable', async () => {
    let answer: object = ready(lobby);
    let now = 1_000;
    const controller = createRoomLaunch({
      scope: scopeOf({ launch: () => Promise.resolve(answer) }),
      roomId,
      newId,
      clock: () => now,
    });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', receivedAt: 1_000 });
    now = 5_000;
    await controller.load();
    expect(controller.getState().receivedAt).toBe(5_000);
    answer = { status: 'unavailable', readId: id(7) };
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
  });

  it('shows the answer at once, sends the round and the option with the generation and no time, and keeps the first', async () => {
    const scope = scopeOf({
      launch: () => Promise.resolve(ready(open)),
      answerLaunch: () => Promise.resolve({ outcome: 'accepted', round: 2 }),
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.answer(1)).toBe(true);
    const view = controller.getState().view?.launch;
    expect(view).toMatchObject({ phase: 'open', yourChoice: 1, youIn: true });
    expect(scope.calls.find((call) => call.name === 'answerLaunch')?.input).toEqual({
      version: 'rooms.v1',
      commandId: expect.stringMatching(/^0199d000-/u) as string,
      roomId,
      launchId,
      round: 2,
      choice: 1,
      recordingGeneration: 4,
    });
    // A second tap on the same question sends nothing: the first answer stands.
    expect(await controller.answer(0)).toBe(false);
    expect(scope.calls.filter((call) => call.name === 'answerLaunch')).toHaveLength(1);
  });

  it('puts the question back and reads again when the server refuses an answer as too late', async () => {
    const scope = scopeOf({
      launch: () => Promise.resolve(ready(open)),
      answerLaunch: () => Promise.reject(refused()),
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.answer(0)).toBe(false);
    expect(controller.getState()).toMatchObject({ refused: true, working: false });
    expect(scope.calls.filter((call) => call.name === 'launch')).toHaveLength(2);
    expect(controller.getState().view?.launch).toMatchObject({ phase: 'open' });
  });

  it('keeps an unknown outcome as the same command, so a retry is not a second answer', async () => {
    let attempts = 0;
    const scope = scopeOf({
      launch: () => Promise.resolve(ready(open)),
      answerLaunch: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(offline()) : Promise.resolve({ outcome: 'accepted', round: 2 });
      },
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.answer(1)).toBe(false);
    expect(controller.getState().offline).toBe(true);
    expect(await controller.answer(1)).toBe(true);
    const [first, second] = scope.calls.filter((call) => call.name === 'answerLaunch') as {
      input: { commandId: string };
    }[];
    expect(second?.input.commandId).toBe(first?.input.commandId);
  });

  it('sends nothing while recording is paused and says so, for start, join and answer', async () => {
    const scope = scopeOf(
      {
        launch: () => Promise.resolve(ready(open)),
        startLaunch: () => Promise.resolve({ outcome: 'accepted' }),
        joinLaunch: () => Promise.resolve({ outcome: 'accepted' }),
        answerLaunch: () => Promise.resolve({ outcome: 'accepted' }),
      },
      { on: false, generation: 5 },
    );
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.start()).toBe(false);
    expect(controller.getState().notSaved).toBe('recording_paused');
    expect(await controller.join()).toBe(false);
    expect(await controller.answer(1)).toBe(false);
    expect(scope.calls.map((call) => call.name)).toEqual(['launch']);
    // The question is back as it was: nothing was kept, so nothing shows as answered.
    expect(controller.getState().view?.launch).toMatchObject({ phase: 'open', youIn: false });
    expect((controller.getState().view?.launch as { yourChoice?: number }).yourChoice).toBeUndefined();
  });

  it('knows recording is paused before any command, and follows the policy only while a screen listens', () => {
    const scope = scopeOf({ launch: () => Promise.resolve(ready(open)) });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    expect(controller.getState().recordingPaused).toBe(false);
    expect(scope.recording.listening()).toBe(0);
    const heard: boolean[] = [];
    const stop = controller.subscribe(() => heard.push(controller.getState().recordingPaused));
    expect(scope.recording.listening()).toBe(1);
    scope.recording.change(false);
    expect(controller.getState().recordingPaused).toBe(true);
    scope.recording.change(false);
    scope.recording.change(true);
    // A change that is not a change tells nobody twice.
    expect(heard).toEqual([true, false]);
    stop();
    expect(scope.recording.listening()).toBe(0);
    const paused = createRoomLaunch({
      scope: scopeOf({ launch: () => Promise.resolve(ready(open)) }, { on: false, generation: 5 }),
      roomId,
      newId,
      clock: () => 0,
    });
    expect(paused.getState().recordingPaused).toBe(true);
  });

  it('says not_saved when the server says the device is out of date, and does not count the answer', async () => {
    const scope = scopeOf({
      launch: () => Promise.resolve(ready(open)),
      answerLaunch: () => Promise.resolve({ outcome: 'not_saved', reason: 'recording_generation_stale' }),
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.answer(1)).toBe(false);
    expect(controller.getState().notSaved).toBe('recording_generation_stale');
    expect((controller.getState().view?.launch as { yourChoice?: number }).yourChoice).toBeUndefined();
  });

  it('starts a Launch and reads it, and joins one that is on', async () => {
    let on = false;
    const scope = scopeOf({
      launch: () => Promise.resolve(ready(on ? lobby : undefined)),
      startLaunch: () => {
        on = true;
        return Promise.resolve({ outcome: 'accepted', launchId, startsInMs: 20_000 });
      },
      joinLaunch: () => Promise.resolve({ outcome: 'accepted', launchId }),
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(controller.getState().view?.launch).toBeUndefined();
    expect(await controller.start()).toBe(true);
    expect(controller.getState().view?.launch).toMatchObject({ phase: 'lobby' });
    expect(await controller.join()).toBe(true);
    expect(scope.calls.find((call) => call.name === 'joinLaunch')?.input).toMatchObject({
      launchId,
      recordingGeneration: 4,
    });
  });

  it('tells the server once that the Launch is over, and reads the podium again for its star', async () => {
    let settled = false;
    const scope = scopeOf({
      launch: () => Promise.resolve(ready({ ...podium, star: settled })),
      finishLaunch: () => {
        settled = true;
        return Promise.resolve({ outcome: 'accepted', launchId });
      },
    });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(controller.getState().view?.launch).toMatchObject({ phase: 'finished', star: true });
    await controller.load();
    await controller.load();
    expect(scope.calls.filter((call) => call.name === 'finishLaunch')).toHaveLength(1);
    expect(scope.calls.find((call) => call.name === 'finishLaunch')?.input).not.toHaveProperty('recordingGeneration');
  });

  it('keeps what it had when a read cannot reach the server', async () => {
    let fail = false;
    const scope = scopeOf({ launch: () => (fail ? Promise.reject(offline()) : Promise.resolve(ready(lobby))) });
    const controller = createRoomLaunch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    fail = true;
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', offline: true });
    expect(controller.getState().view?.launch).toMatchObject({ phase: 'lobby' });
    const first = createRoomLaunch({
      scope: scopeOf({ launch: () => Promise.reject(offline()) }),
      roomId,
      newId,
      clock: () => 0,
    });
    await first.load();
    expect(first.getState()).toMatchObject({ phase: 'failed', offline: true });
  });
});
