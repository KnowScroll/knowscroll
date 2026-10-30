import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { problemDetails } from '@knowscroll/contracts';
import type { RoomRefusal, RoomUseCases } from '@knowscroll/backend/modules/rooms';
import { RoomsController } from './rooms.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const accountId = id(1),
  universeId = id(2),
  roomId = id(3),
  discussionId = id(4),
  commandId = id(5);
const scope = { accountId, privacyEpoch: 2 };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account' as const, accountId } };

async function admitted() {
  const request = { path: '/v1/rooms/list', headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () => Promise.resolve({ ...scope, universeId, sessionId: id(6), credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}

const refused = (code: RoomRefusal) => Promise.resolve({ kind: 'refused' as const, code });

function controllerOver(overrides: Partial<Record<keyof RoomUseCases, RoomUseCases[keyof RoomUseCases]>>) {
  const useCases = new Proxy(overrides, {
    get: (target, name: string) => target[name as keyof RoomUseCases] ?? (() => refused('unavailable')),
  }) as unknown as RoomUseCases;
  return new RoomsController(useCases);
}

describe('RoomsController', () => {
  it('hands each route the caller’s authority and the unparsed body, and returns the use case’s answer', async () => {
    const ask = vi.fn<RoomUseCases['ask']>(() =>
      Promise.resolve({
        kind: 'ok',
        value: {
          version: 'rooms.v1',
          scope,
          commandId,
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'inhabitant.ask',
          roomId,
          discussionId,
          inhabitant: 'skeptic',
        },
      }),
    );
    const request = await admitted();
    const input = { version: 'rooms.v1' as const, commandId, roomId, discussionId, inhabitant: 'skeptic' as const };
    const answer = await call(controllerOver({ ask }).askInhabitantRoute(request), input);
    expect(answer).toMatchObject({ operation: 'inhabitant.ask', inhabitant: 'skeptic' });
    expect(ask).toHaveBeenCalledExactlyOnceWith(authority, input);
  });

  it('serves the stations of a map and a poll vote by the same rules', async () => {
    const stations = vi.fn<RoomUseCases['stations']>(() =>
      Promise.resolve({
        kind: 'ok',
        value: { version: 'rooms.v1', scope, readId: commandId, status: 'ready', stations: [] },
      }),
    );
    const votePoll = vi.fn<RoomUseCases['votePoll']>(() => refused('rate_limited'));
    const request = await admitted();
    const controller = controllerOver({ stations, votePoll });
    const read = { version: 'rooms.v1' as const, readId: commandId };
    expect(await call(controller.stationsRoute(request), read)).toMatchObject({ status: 'ready', stations: [] });
    expect(stations).toHaveBeenCalledExactlyOnceWith(authority, read);
    const failure = await call(controller.votePollRoute(request), {
      version: 'rooms.v1' as const,
      commandId,
      roomId,
      activityId: id(7),
      optionId: 'o1',
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: problemDetails('TOO_MANY_REQUESTS').status });
  });

  it('hands a member’s own settings and the lease of an open room to their use cases, as the caller', async () => {
    const setPreferences = vi.fn<RoomUseCases['setPreferences']>(() =>
      Promise.resolve({
        kind: 'ok',
        value: {
          version: 'rooms.v1',
          scope,
          commandId,
          recordedAt: '2026-10-24T08:00:00.000Z',
          replayed: false,
          outcome: 'accepted',
          operation: 'room.preferences',
          roomId,
          you: { aiLevel: 'off', keepOut: true },
        },
      }),
    );
    const setPresence = vi.fn<RoomUseCases['setPresence']>(() =>
      Promise.resolve({ kind: 'ok', value: { version: 'rooms.v1', scope, roomId, state: 'here' } }),
    );
    const request = await admitted();
    const controller = controllerOver({ setPreferences, setPresence });
    const preferences = { version: 'rooms.v1' as const, commandId, roomId, aiLevel: 'off' as const, keepOut: true };
    expect(await call(controller.preferencesRoute(request), preferences)).toMatchObject({
      you: { aiLevel: 'off', keepOut: true },
    });
    expect(setPreferences).toHaveBeenCalledExactlyOnceWith(authority, preferences);
    const presence = { version: 'rooms.v1' as const, roomId, state: 'here' as const };
    expect(await call(controller.presenceRoute(request), presence)).toMatchObject({ state: 'here' });
    expect(setPresence).toHaveBeenCalledExactlyOnceWith(authority, presence);
    // A person who is not a member of the room is refused in the one shape every room refusal has.
    const refusedPresence = await call(
      controllerOver({ setPresence: () => refused('unavailable') }).presenceRoute(request),
      presence,
    ).catch((error: unknown) => error);
    expect(refusedPresence).toMatchObject({ status: problemDetails('SHARING_UNAVAILABLE').status });
  });

  it.each([
    ['invalid_input', 'INVALID_REQUEST'],
    ['command_key_reused', 'COMMAND_KEY_REUSED'],
    ['rate_limited', 'TOO_MANY_REQUESTS'],
    ['unavailable', 'SHARING_UNAVAILABLE'],
  ] as const)('answers a %s refusal with the closed Social problem %s and nothing else', async (code, problem) => {
    const status = problemDetails(problem).status;
    const send = vi.fn<RoomUseCases['send']>(() => refused(code));
    const request = await admitted();
    const failure = await call(controllerOver({ send }).sendRoute(request), {
      version: 'rooms.v1' as const,
      commandId,
      roomId,
      discussionId,
      body: { kind: 'text' as const, text: 'hello' },
    }).catch((error: unknown) => error as { code: string; status: number; data: Record<string, unknown> });
    expect(failure).toMatchObject({ code: problem, status });
    expect(Object.keys((failure as { data: Record<string, unknown> }).data).sort()).toEqual(
      ['code', 'status', 'title', 'type'].sort(),
    );
  });
});
