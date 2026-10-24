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

  it.each([
    ['invalid_input', 'INVALID_REQUEST', 400],
    ['command_key_reused', 'COMMAND_KEY_REUSED', 409],
    ['rate_limited', 'TOO_MANY_REQUESTS', 429],
    ['unavailable', 'SHARING_UNAVAILABLE', problemDetails('SHARING_UNAVAILABLE').status],
  ] as const)(
    'answers a %s refusal with the closed Social problem %s and nothing else',
    async (code, problem, status) => {
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
    },
  );
});
