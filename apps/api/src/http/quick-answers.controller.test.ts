import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  QUICK_ANSWER_LABEL,
  type AskQuickAnswer,
  type AskQuickAnswerResult,
  type DismissQuickAnswerResult,
  type ProblemCode,
  type QuickAnswerStatus,
} from '@knowscroll/contracts';
import type { QuickAnswerRefusal } from '@knowscroll/backend/modules/supply';
import type { Caller } from './callers.js';
import { QuickAnswersController } from './quick-answers.controller.js';
import { scopeGuard } from './scope-guard.js';

const id = '0199a000-0000-7000-8000-000000000001';
const accountId = '0199a000-0000-7000-8000-000000000002';
const caller: Caller = { accountId, universeId: id, privacyEpoch: 2, sessionId: id, credential: 'cookie' };
const authority = { universeId: id, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const askInput: AskQuickAnswer = {
  version: 'quick-answer-ask.v1',
  commandId: id,
  source: { assetId: id, assetRevision: 1 },
  stopId: 'the-lean',
  passage: 'keeps pointing the same way',
  recordingGeneration: 1,
};
const accepted: AskQuickAnswerResult = {
  version: 'quick-answer-receipt.v1',
  outcome: 'accepted',
  commandId: id,
  quickAnswerId: id,
  recordedAt: '2026-11-01T00:00:00.000Z',
  privacyEpoch: 2,
  replayed: false,
};
const answered: QuickAnswerStatus = {
  version: 'quick-answer-status.v1',
  quickAnswerId: id,
  privacyEpoch: 2,
  status: 'answered',
  label: QUICK_ANSWER_LABEL,
  question: 'Why does it keep pointing?',
  answer: 'Nothing turns the axis during a year.',
  covered: true,
};
const dismissed: DismissQuickAnswerResult = { version: 'quick-answer-dismissed.v1', quickAnswerId: id };

async function admittedRequest(): Promise<Request> {
  const request = { path: '/v1/quick-answers', headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}

function wired() {
  const ask = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: accepted }));
  const read = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: answered }));
  const dismiss = vi.fn(() => Promise.resolve({ kind: 'ok' as const, value: dismissed }));
  return { controller: new QuickAnswersController(ask, read, dismiss), ask, read, dismiss };
}

describe('Quick answers guarded HTTP contract adapter (D-253)', () => {
  it('dispatches exact inputs with admitted authority, and the answer carries its label', async () => {
    const { controller, ask, read, dismiss } = wired();
    const request = await admittedRequest();
    expect(await call(controller.askRoute(request), askInput)).toEqual(accepted);
    expect(ask).toHaveBeenCalledExactlyOnceWith(authority, askInput);
    expect(await call(controller.readRoute(request), { quickAnswerId: id })).toEqual(answered);
    expect(read).toHaveBeenCalledExactlyOnceWith(authority, { quickAnswerId: id });
    expect(await call(controller.dismissRoute(request), { quickAnswerId: id })).toEqual(dismissed);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(authority, { quickAnswerId: id });
  });

  const refusalCodes: Record<QuickAnswerRefusal, ProblemCode> = {
    scope_refused: 'UNIVERSE_UNAVAILABLE',
    command_key_reused: 'COMMAND_KEY_REUSED',
    receipt_unavailable: 'SERVICE_UNAVAILABLE',
    source_unavailable: 'ASSET_NOT_FOUND',
    not_found: 'NOT_FOUND',
    recording_paused: 'RECORDING_PAUSED',
    recording_stale: 'RECORDING_POLICY_STALE',
  };
  for (const reason of Object.keys(refusalCodes) as QuickAnswerRefusal[])
    it(`maps ${reason} consistently without backend details`, async () => {
      const refused = vi.fn(() => Promise.resolve({ kind: 'refused' as const, reason }));
      const controller = new QuickAnswersController(refused, refused, refused);
      const request = await admittedRequest();
      for (const invoke of [
        () => call(controller.askRoute(request), askInput),
        () => call(controller.readRoute(request), { quickAnswerId: id }),
        () => call(controller.dismissRoute(request), { quickAnswerId: id }),
      ])
        await expect(invoke()).rejects.toMatchObject({ code: refusalCodes[reason], data: {} });
    });

  it('refuses every unguarded handler before its use case runs', async () => {
    const { controller, ask, read, dismiss } = wired();
    const request = {} as unknown as Request;
    await expect(call(controller.askRoute(request), askInput)).rejects.toThrow('without the scope guard');
    await expect(call(controller.readRoute(request), { quickAnswerId: id })).rejects.toThrow('without the scope guard');
    await expect(call(controller.dismissRoute(request), { quickAnswerId: id })).rejects.toThrow(
      'without the scope guard',
    );
    expect(ask).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('strictly validates every input before dispatch: another account, a blank passage, a long question', async () => {
    const { controller, ask, read } = wired();
    const request = await admittedRequest();
    for (const bad of [
      { ...askInput, accountId },
      { ...askInput, passage: '   ' },
      { ...askInput, question: 'ab' },
      { ...askInput, question: 'x'.repeat(201) },
      { ...askInput, commandId: 'bad' },
    ])
      await expect(call(controller.askRoute(request), bad)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(call(controller.readRoute(request), { quickAnswerId: 'bad' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(ask).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('validates backend output instead of emitting an answer with another label', async () => {
    const read = vi.fn(() =>
      Promise.resolve({ kind: 'ok' as const, value: { ...answered, label: 'A checked Scroll' } as never }),
    );
    const { ask, dismiss } = wired();
    const controller = new QuickAnswersController(ask, read, dismiss);
    await expect(call(controller.readRoute(await admittedRequest()), { quickAnswerId: id })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
