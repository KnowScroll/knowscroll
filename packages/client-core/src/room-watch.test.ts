import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails, type WatchSessionView } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import {
  SYNC_TOLERANCE_MS,
  WATCH_START_BLOCK_WORDS,
  clockMs,
  clockWords,
  createRoomWatch,
  lastOnStageWords,
  msUntilNextWatchRead,
  positionWords,
  syncSeekSeconds,
  watchChip,
  watchPhaseNow,
  watchingLine,
} from './room-watch';

const id = (n: number) => `0199d000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const sessionId = id(2);
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
    change: (on: boolean) => {
      recording.on = on;
      for (const listener of [...listeners]) listener();
    },
  };
  return { active: true, api: { rooms: wrapped }, calls, recording: session } as unknown as AccountScope & {
    calls: { name: string; input: unknown }[];
    recording: typeof session;
  };
}
let counter = 100;
const newId = () => id(counter++);

const reel = { assetId: id(3), assetRevision: 1, title: 'How big is the universe?', durationMs: 70_000 };
const common = { sessionId, reel, youIn: false, canStop: false };
const starting: WatchSessionView = { phase: 'starting', ...common, startsInMs: 4_000 };
const playing: WatchSessionView = { phase: 'playing', ...common, elapsedMs: 41_000 };
const ready = (extra: object = {}) => ({ status: 'ready', readId: id(7), ...extra });
const accepted = (operation: string) => ({ outcome: 'accepted', operation, sessionId });
const notSaved = (reason: string) => ({ outcome: 'not_saved', reason });

describe('the shared clock counts the server’s milliseconds, not the device’s date (D-256)', () => {
  it('counts on from the time the view carried, by the steady clock since it arrived', () => {
    expect(clockMs(playing, 0)).toBe(41_000);
    expect(clockMs(playing, 2_500)).toBe(43_500);
    expect(clockMs(starting, 1_000)).toBe(-3_000);
    expect(clockMs(starting, 4_000)).toBe(0);
    expect(clockMs(playing, -50)).toBe(41_000);
  });

  it('is the same on two devices told the same time, whatever their own clocks say', () => {
    expect(clockMs(playing, 7_000)).toBe(clockMs({ ...playing }, 7_000));
  });

  it('knows when the session is starting, playing and over', () => {
    expect(watchPhaseNow(starting, 3_999)).toBe('starting');
    expect(watchPhaseNow(starting, 4_000)).toBe('playing');
    expect(watchPhaseNow(playing, 28_999)).toBe('playing');
    expect(watchPhaseNow(playing, 29_000)).toBe('over');
  });

  it('reads again just after the phase it shows has ended, and never when there is no session', () => {
    expect(msUntilNextWatchRead(undefined, 0)).toBeUndefined();
    expect(msUntilNextWatchRead(starting, 1_000)).toBe(3_150);
    expect(msUntilNextWatchRead(playing, 1_000)).toBe(28_000 + 150);
    expect(msUntilNextWatchRead(playing, 60_000)).toBe(150);
  });

  it('moves a player only when it has drifted more than a second and a half from the clock', () => {
    expect(syncSeekSeconds(41_000, 41_000)).toBeUndefined();
    expect(syncSeekSeconds(41_000, 41_000 + SYNC_TOLERANCE_MS)).toBeUndefined();
    expect(syncSeekSeconds(41_000, 41_000 - SYNC_TOLERANCE_MS)).toBeUndefined();
    expect(syncSeekSeconds(41_000, 43_501)).toBeCloseTo(2.501);
    expect(syncSeekSeconds(45_000, 41_000)).toBe(-4);
  });
});

describe('the words of the stage', () => {
  it('writes the clock as minutes and seconds, rounded down', () => {
    expect(clockWords(0)).toBe('0:00');
    expect(clockWords(41_999)).toBe('0:41');
    expect(clockWords(70_000)).toBe('1:10');
    expect(clockWords(-5)).toBe('0:00');
  });

  it('draws the line under the picture, and says how long before the first frame', () => {
    expect(positionWords(playing, 0)).toBe('0:41 / 1:10 · synced for everyone');
    expect(positionWords(playing, 1_000)).toBe('0:42 / 1:10 · synced for everyone');
    expect(positionWords(starting, 1_000)).toBe('Starting in 3 s');
    expect(positionWords(playing, 100_000)).toBe('1:10 / 1:10 · synced for everyone');
  });

  it('says "N watching" only when the view carries the number, which it does only from three', () => {
    expect(watchingLine(playing)).toBeUndefined();
    expect(watchingLine({ ...playing, watching: 4 })).toBe('4 watching');
    expect(watchingLine({ ...starting, watching: 3 })).toBe('3 watching');
  });

  it('says what the chip offers for each state of the room, and why a Reel cannot start', () => {
    expect(watchChip(undefined)).toBeUndefined();
    expect(watchChip({ state: 'ready' })).toEqual({ label: 'Watch together', detail: 'Start a Reel' });
    // While one is on, the stage and the band say so: the chip has nothing to add.
    expect(watchChip({ state: 'live' })).toBeUndefined();
    for (const words of Object.values(WATCH_START_BLOCK_WORDS)) expect(words.length).toBeGreaterThan(10);
  });

  it('says what was last on the stage, against today and yesterday in the device’s zone', () => {
    const now = new Date('2026-11-01T22:00:00.000Z');
    expect(lastOnStageWords(undefined, now, 'UTC')).toBeUndefined();
    expect(lastOnStageWords({ kind: 'launch', at: '2026-10-31T21:30:00.000Z' }, now, 'UTC')).toBe(
      'Last on stage: the Launch, yesterday at 21:30',
    );
    expect(
      lastOnStageWords({ kind: 'reel', at: '2026-11-01T21:05:00.000Z', title: 'A blanket made of gas' }, now, 'UTC'),
    ).toBe('Last on stage: the Reel “A blanket made of gas”, today at 21:05');
    expect(lastOnStageWords({ kind: 'launch', at: '2026-10-20T08:00:00.000Z' }, now, 'UTC')).toBe(
      'Last on stage: the Launch, 20 Oct at 08:00',
    );
  });
});

describe('Watch together on the client', () => {
  it('reads the stage and says nothing of why a room is unavailable', async () => {
    const scope = scopeOf({ watch: () => Promise.resolve(ready({ session: playing })) });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 500 });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', receivedAt: 500, offline: false });
    expect(controller.getState().view?.session).toEqual(playing);
    expect(scope.calls[0]).toMatchObject({ name: 'watch', input: { version: 'rooms.v1', roomId } });

    const gone = scopeOf({ watch: () => Promise.resolve({ status: 'unavailable', readId: id(7) }) });
    const other = createRoomWatch({ scope: gone, roomId, newId, clock: () => 0 });
    await other.load();
    expect(other.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
    const refusedScope = scopeOf({ watch: () => Promise.reject(refused()) });
    const third = createRoomWatch({ scope: refusedScope, roomId, newId, clock: () => 0 });
    await third.load();
    expect(third.getState().phase).toBe('unavailable');
  });

  it('keeps what it had when a read cannot reach the server, and fails only when it never had anything', async () => {
    let up = true;
    const scope = scopeOf({
      watch: () => (up ? Promise.resolve(ready({ session: playing })) : Promise.reject(offline())),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    up = false;
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'failed', offline: true });
    up = true;
    await controller.load();
    up = false;
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', offline: true });
    expect(controller.getState().view?.session).toEqual(playing);
  });

  it('recovers from a dropped hint with one read: the stage is whatever the server says now', async () => {
    let current: object = ready({ session: playing });
    const scope = scopeOf({ watch: () => Promise.resolve(current) });
    let clock = 0;
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => clock });
    await controller.load();
    expect(controller.getState().view?.session?.phase).toBe('playing');
    // The session ended and another began while no hint arrived: the next read says so, and counts from its own arrival.
    current = ready({ session: { ...starting, sessionId: id(9) } });
    clock = 9_000;
    await controller.load();
    expect(controller.getState().view?.session).toMatchObject({ sessionId: id(9), phase: 'starting' });
    expect(controller.getState().receivedAt).toBe(9_000);
    current = ready({ start: { allowed: true }, last: { kind: 'reel', at: '2026-11-01T21:00:00.000Z' } });
    await controller.load();
    expect(controller.getState().view?.session).toBeUndefined();
  });

  it('reads the Reels only when asked, and keeps them', async () => {
    const scope = scopeOf({ watchReels: () => Promise.resolve({ status: 'ready', readId: id(7), reels: [reel] }) });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    expect(controller.getState().reels).toBeUndefined();
    await controller.loadReels();
    expect(controller.getState().reels).toEqual([reel]);
    const failing = scopeOf({ watchReels: () => Promise.reject(offline()) });
    const other = createRoomWatch({ scope: failing, roomId, newId, clock: () => 0 });
    await other.loadReels();
    expect(other.getState()).toMatchObject({ reels: undefined, reelsFailed: true });
  });

  it('starts a Reel with the recording generation and no time, and reads the stage it made', async () => {
    const scope = scopeOf({
      startWatch: () => Promise.resolve({ ...accepted('watch.start'), startsInMs: 5_000 }),
      watch: () => Promise.resolve(ready({ session: { ...starting, youIn: true } })),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    expect(await controller.start(reel.assetId)).toBe(true);
    const sent = scope.calls.find((call) => call.name === 'startWatch')!.input as Record<string, unknown>;
    expect(sent).toMatchObject({ roomId, assetId: reel.assetId, recordingGeneration: 4 });
    expect(Object.keys(sent).sort()).toEqual(['assetId', 'commandId', 'recordingGeneration', 'roomId', 'version']);
    expect(controller.getState().view?.session).toMatchObject({ youIn: true, phase: 'starting' });
  });

  it('joins the session that is on, and sends the session and the generation and nothing about where it is', async () => {
    const scope = scopeOf({
      joinWatch: () => Promise.resolve(accepted('watch.join')),
      watch: () => Promise.resolve(ready({ session: { ...playing, youIn: true } })),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.join()).toBe(true);
    const sent = scope.calls.find((call) => call.name === 'joinWatch')!.input as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['commandId', 'recordingGeneration', 'roomId', 'sessionId', 'version']);
    expect(controller.getState().view?.session?.youIn).toBe(true);
  });

  it('sends nothing while recording is paused and says so, for start and join, but always lets a person leave', async () => {
    const scope = scopeOf(
      {
        startWatch: () => Promise.resolve(accepted('watch.start')),
        joinWatch: () => Promise.resolve(accepted('watch.join')),
        leaveWatch: () => Promise.resolve(accepted('watch.leave')),
        watch: () => Promise.resolve(ready({ session: { ...playing, youIn: true } })),
      },
      { on: false, generation: 5 },
    );
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    expect(controller.getState().recordingPaused).toBe(true);
    await controller.load();
    expect(await controller.start(reel.assetId)).toBe(false);
    expect(controller.getState().notSaved).toBe('recording_paused');
    expect(await controller.join()).toBe(false);
    expect(scope.calls.filter((call) => call.name === 'startWatch' || call.name === 'joinWatch')).toHaveLength(0);
    expect(await controller.leave()).toBe(true);
    expect(scope.calls.some((call) => call.name === 'leaveWatch')).toBe(true);
  });

  it('knows recording is paused before any command, and follows the policy only while a screen listens', () => {
    const scope = scopeOf({}, { on: true, generation: 1 });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    expect(controller.getState().recordingPaused).toBe(false);
    const heard: boolean[] = [];
    const stop = controller.subscribe(() => heard.push(controller.getState().recordingPaused));
    scope.recording.change(false);
    scope.recording.change(true);
    expect(heard).toEqual([true, false]);
    stop();
    scope.recording.change(false);
    expect(heard).toEqual([true, false]);
  });

  it('says not_saved when the server says the device is out of date, and does not count it as joined', async () => {
    const scope = scopeOf({
      joinWatch: () => Promise.resolve(notSaved('recording_generation_stale')),
      watch: () => Promise.resolve(ready({ session: playing })),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.join()).toBe(false);
    expect(controller.getState()).toMatchObject({ notSaved: 'recording_generation_stale', working: false });
    expect(controller.getState().view?.session?.youIn).toBe(false);
  });

  it('reads the stage again when the server refuses, and keeps an unknown outcome as the same command', async () => {
    let attempts = 0;
    const ids: string[] = [];
    const scope = scopeOf({
      joinWatch: (input: never) => {
        ids.push((input as { commandId: string }).commandId);
        attempts += 1;
        return attempts === 1 ? Promise.reject(offline()) : Promise.resolve(accepted('watch.join'));
      },
      watch: () => Promise.resolve(ready({ session: playing })),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.join()).toBe(false);
    expect(controller.getState().offline).toBe(true);
    expect(await controller.join()).toBe(true);
    expect(ids[0]).toBe(ids[1]);

    const refusing = scopeOf({
      joinWatch: () => Promise.reject(refused()),
      watch: () => Promise.resolve(ready({ start: { allowed: true } })),
    });
    const other = createRoomWatch({ scope: refusing, roomId, newId, clock: () => 0 });
    await other.load();
    // Nothing to join once the session is gone: the controller sends nothing and says so only through the next read.
    expect(await other.join()).toBe(false);
    expect(refusing.calls.filter((call) => call.name === 'joinWatch')).toHaveLength(0);
  });

  it('says a session is joined here only after this device’s own Join or Start was accepted (D-258)', async () => {
    // The server says the person is in (from another device, or from before the room was reopened): this device did not join.
    const seen = scopeOf({ watch: () => Promise.resolve(ready({ session: { ...playing, youIn: true } })) });
    const idle = createRoomWatch({ scope: seen, roomId, newId, clock: () => 0 });
    await idle.load();
    expect(idle.getState().view?.session?.youIn).toBe(true);
    expect(idle.getState().joinedHere).toEqual([]);

    const server = { youIn: false };
    const scope = scopeOf({
      watch: () => Promise.resolve(ready({ session: { ...playing, youIn: server.youIn } })),
      joinWatch: () => {
        server.youIn = true;
        return Promise.resolve(accepted('watch.join'));
      },
      startWatch: () => {
        server.youIn = true;
        return Promise.resolve({ ...accepted('watch.start'), startsInMs: 5_000 });
      },
      leaveWatch: () => {
        server.youIn = false;
        return Promise.resolve(accepted('watch.leave'));
      },
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(controller.getState().joinedHere).toEqual([]);
    await controller.join();
    expect(controller.getState().joinedHere).toEqual([sessionId]);
    // A read that finds the person still in keeps it; leaving drops it at once.
    await controller.load();
    expect(controller.getState().joinedHere).toEqual([sessionId]);
    await controller.leave();
    expect(controller.getState().joinedHere).toEqual([]);
    // Starting a Reel joins it here too.
    await controller.start(reel.assetId);
    expect(controller.getState().joinedHere).toEqual([sessionId]);
  });

  it('drops a joined session when a read says the person is out of it, or that it is over, and a refused Join adds nothing', async () => {
    const server: { current: object } = { current: ready({ session: playing }) };
    const scope = scopeOf({
      watch: () => Promise.resolve(server.current),
      joinWatch: () => Promise.resolve(accepted('watch.join')),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    await controller.join();
    // The server holds a person's place only while the session is on: this read says they are out (a Clear, a removal).
    server.current = ready({ session: { ...playing, youIn: false } });
    await controller.load();
    expect(controller.getState().joinedHere).toEqual([]);
    // Another session with the person in it was not joined from here.
    server.current = ready({ session: { ...playing, sessionId: id(9), youIn: true } });
    await controller.load();
    expect(controller.getState().joinedHere).toEqual([]);

    const refusing = scopeOf({
      watch: () => Promise.resolve(ready({ session: playing })),
      joinWatch: () => Promise.reject(refused()),
    });
    const other = createRoomWatch({ scope: refusing, roomId, newId, clock: () => 0 });
    await other.load();
    await other.join();
    expect(other.getState().joinedHere).toEqual([]);
  });

  it('leaves and stops with the session, and reads the stage after', async () => {
    const scope = scopeOf({
      leaveWatch: () => Promise.resolve(accepted('watch.leave')),
      stopWatch: () => Promise.resolve(accepted('watch.stop')),
      watch: () => Promise.resolve(ready({ session: { ...playing, canStop: true } })),
    });
    const controller = createRoomWatch({ scope, roomId, newId, clock: () => 0 });
    await controller.load();
    expect(await controller.leave()).toBe(true);
    expect(await controller.stop()).toBe(true);
    expect(scope.calls.map((call) => call.name)).toEqual(['watch', 'leaveWatch', 'watch', 'stopWatch', 'watch']);
    const stopped = scope.calls.find((call) => call.name === 'stopWatch')!.input as Record<string, unknown>;
    expect(stopped).toMatchObject({ roomId, sessionId });
    expect(stopped).not.toHaveProperty('recordingGeneration');
  });
});
