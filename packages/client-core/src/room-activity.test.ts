import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { createRoomActivities, createRoomActivity } from './room-activity';

const id = (n: number) => `0199b000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const roomId = id(1);
const activityId = id(2);

const unavailable = () =>
  new ORPCError('SHARING_UNAVAILABLE', { status: 403, data: problemDetails('SHARING_UNAVAILABLE') });
const offline = () => new Error('network');

type Api = Record<string, (input: never) => Promise<unknown>>;
function scopeOf(rooms: Api): AccountScope & { calls: { name: string; input: unknown }[] } {
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

const summary = {
  activityId,
  kind: 'poll' as const,
  title: 'Which first?',
  state: 'open' as const,
  startedAt: '2026-10-24T08:00:00.000Z',
  voted: false,
};
const poll = (yourVote?: string) => ({
  status: 'ready' as const,
  roomId,
  activityId,
  state: 'open' as const,
  startedAt: summary.startedAt,
  canModerate: false,
  activity: {
    kind: 'poll' as const,
    prompt: 'Which first?',
    options: [
      { optionId: 'o1', text: 'Batching', votes: yourVote === 'o1' ? 1 : 0, voters: [] },
      { optionId: 'o2', text: 'Instances', votes: yourVote === 'o2' ? 1 : 0, voters: [] },
    ],
    ...(yourVote === undefined ? {} : { yourVote }),
    canVote: true,
  },
});

describe('the activities of a room on the client', () => {
  it('lists them for a member and says nothing of why a room is unavailable', async () => {
    let answer: object = { status: 'ready', roomId, canCreate: true, activities: [summary] };
    const scope = scopeOf({ activities: () => Promise.resolve(answer) });
    const controller = createRoomActivities({ scope, roomId, newId });
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', canCreate: true, activities: [summary] });
    answer = { status: 'unavailable' };
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', activities: [], canCreate: false });
  });

  it('keeps the list it has when a later read does not arrive', async () => {
    let fails = false;
    const scope = scopeOf({
      activities: () =>
        fails
          ? Promise.reject(offline())
          : Promise.resolve({ status: 'ready', roomId, canCreate: false, activities: [summary] }),
    });
    const controller = createRoomActivities({ scope, roomId, newId });
    await controller.load();
    fails = true;
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'ready', offline: true, activities: [summary] });
  });

  it('starts a poll once: an unknown outcome is retried as the identical command', async () => {
    let reached = false;
    const scope = scopeOf({
      activities: () => Promise.resolve({ status: 'ready', roomId, canCreate: true, activities: [] }),
      createActivity: () => (reached ? Promise.resolve({ activityId }) : Promise.reject(offline())),
    });
    const controller = createRoomActivities({ scope, roomId, newId });
    const poll = { kind: 'poll' as const, prompt: 'Which first?', options: ['Batching', 'Instances'] };
    expect(await controller.create(poll)).toBeUndefined();
    expect(controller.getState().offline).toBe(true);
    reached = true;
    expect(await controller.create(poll)).toBe(activityId);
    const sent = scope.calls.filter((call) => call.name === 'createActivity').map((call) => call.input);
    expect(sent).toHaveLength(2);
    expect((sent[0] as { commandId: string }).commandId).toBe((sent[1] as { commandId: string }).commandId);
  });

  it('says a refusal plainly and reads the list again', async () => {
    const scope = scopeOf({
      activities: () => Promise.resolve({ status: 'ready', roomId, canCreate: false, activities: [] }),
      createActivity: () => Promise.reject(unavailable()),
    });
    const controller = createRoomActivities({ scope, roomId, newId });
    expect(await controller.create({ kind: 'poll', prompt: 'x', options: ['a', 'b'] })).toBeUndefined();
    expect(controller.getState()).toMatchObject({ refused: true, canCreate: false });
    expect(scope.calls.map((call) => call.name)).toEqual(['createActivity', 'activities']);
  });
});

describe('one activity on the client', () => {
  it('votes, then reads the poll with the vote in it', async () => {
    let voted: string | undefined;
    const scope = scopeOf({
      readActivity: () => Promise.resolve(poll(voted)),
      votePoll: (input: { optionId: string }) => {
        voted = input.optionId;
        return Promise.resolve({ optionId: input.optionId });
      },
    });
    const controller = createRoomActivity({ scope, roomId, activityId, newId });
    await controller.load();
    expect(controller.getState().phase).toBe('ready');
    expect(await controller.vote('o2')).toBe(true);
    expect(controller.getState().view?.activity).toMatchObject({ yourVote: 'o2' });
  });

  it('keeps an unsent vote as "not sent yet" and sends the identical command again', async () => {
    let reached = false;
    const scope = scopeOf({
      readActivity: () => Promise.resolve(poll()),
      votePoll: (input: { optionId: string }) =>
        reached ? Promise.resolve({ optionId: input.optionId }) : Promise.reject(offline()),
    });
    const controller = createRoomActivity({ scope, roomId, activityId, newId });
    await controller.load();
    expect(await controller.vote('o1')).toBe(false);
    expect(controller.getState()).toMatchObject({ notSent: 'o1', offline: true });
    reached = true;
    expect(await controller.vote('o1')).toBe(true);
    expect(controller.getState().notSent).toBeUndefined();
    const votes = scope.calls
      .filter((call) => call.name === 'votePoll')
      .map((call) => (call.input as { commandId: string }).commandId);
    expect(votes[0]).toBe(votes[1]);
  });

  it('answers a closed poll or a removed activity with one unavailable state', async () => {
    let answer: object = poll();
    const scope = scopeOf({
      readActivity: () => Promise.resolve(answer),
      votePoll: () => Promise.reject(unavailable()),
    });
    const controller = createRoomActivity({ scope, roomId, activityId, newId });
    await controller.load();
    expect(await controller.vote('o1')).toBe(false);
    expect(controller.getState().refused).toBe(true);
    answer = { status: 'unavailable' };
    await controller.load();
    expect(controller.getState()).toMatchObject({ phase: 'unavailable', view: undefined });
  });

  it('closes and removes through one moderation command each', async () => {
    const scope = scopeOf({
      readActivity: () => Promise.resolve(poll()),
      moderateActivity: (input: { action: string }) => Promise.resolve({ action: input.action }),
    });
    const controller = createRoomActivity({ scope, roomId, activityId, newId });
    expect(await controller.moderate('close')).toBe(true);
    expect(await controller.moderate('remove')).toBe(true);
    expect(
      scope.calls
        .filter((call) => call.name === 'moderateActivity')
        .map((call) => (call.input as { action: string }).action),
    ).toEqual(['close', 'remove']);
  });
});
