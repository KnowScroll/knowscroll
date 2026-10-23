import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { IngestObservations } from '@knowscroll/backend/modules/evidence';
import type { RecordingObservationBatchRequest } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { ObservationsController } from './observations.controller.js';
import { scopeGuard } from './scope-guard.js';

const noLog: LogEvent = () => undefined;
const exposureId = '0199a000-0000-7000-8000-0000000000e1';

/** The controller over use cases that must never be reached (the gate answers first). */
function controllerIn(world: string) {
  const unreachable = () => Promise.reject(new Error('the use case must not run'));
  return new ObservationsController(unreachable, unreachable, { world } as ApiConfig, noLog);
}

describe('the dev-only evidence diagnostics route', () => {
  it.each(['live', 'production', 'prod', 'whatever'])(
    'answers 404 in the %s world, before anything is read',
    async (world) => {
      const procedure = controllerIn(world).evidenceDiagnosticsRoute({} as Request);
      await expect(call(procedure, { exposureId })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    },
  );

  it.each(['dev', 'stage', 'ci', 'local'])(
    'is served in the %s world (it then needs the caller the scope guard admitted)',
    async (world) => {
      const procedure = controllerIn(world).evidenceDiagnosticsRoute({} as Request);
      // Reached the handler past the gate: with no admitted caller it fails closed with a plain error, not NOT_FOUND.
      await expect(call(procedure, { exposureId })).rejects.not.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
});

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const accountId = id(1),
  universeId = id(2);
const scope = { accountId, privacyEpoch: 2 };
const authority = { universeId, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const batch: RecordingObservationBatchRequest = {
  version: 'observation-batch.v2',
  recordingGeneration: 3,
  instrumentationVersion: 1,
  events: [10, 11, 12].map((n) => ({
    schemaVersion: 'interaction.v1',
    eventId: id(n),
    sessionId: id(4),
    deviceSequence: n - 9,
    exposureId,
    assetId: id(5),
    assetRevision: 1,
    occurredAt: '2026-10-22T00:00:00.000Z',
    kind: 'scroll.active_dwell',
    payload: { activeIntervalsMs: [[0, 1]] },
  })),
};
async function admitted(path = '/v1/observations/recording-batch') {
  const request = { path, headers: { 'x-ks-scope': `${accountId}:2` } } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: {
      resolve: () => Promise.resolve({ ...scope, universeId, sessionId: id(3), credential: 'bearer' }),
      sessionValid: () => Promise.resolve(true),
    },
    logEvent: noLog,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
const ingested = {
  kind: 'ingested' as const,
  recordingGeneration: 3,
  accepted: 1,
  duplicates: 1,
  rejected: 1,
  results: [
    { eventId: id(10), status: 'accepted' as const },
    { eventId: id(11), status: 'duplicate' as const },
    { eventId: id(12), status: 'rejected' as const, reason: 'exposure_unknown' as const },
  ],
  revision: 7,
};
function fixture() {
  const ingest = vi.fn<IngestObservations>(() => Promise.resolve(ingested));
  const log = vi.fn<(event: string, fields?: unknown) => void>();
  const logEvent: LogEvent = (event, fields) => log(event, fields);
  const diagnostics = () => Promise.reject(new Error('no diagnostics expected'));
  return {
    ingest,
    log,
    controller: new ObservationsController(ingest, diagnostics, { world: 'ci' } as ApiConfig, logEvent),
  };
}

describe('recording observation HTTP adapters (authored transport fixtures)', () => {
  it('passes guard-admitted authority and the unchanged original batch, correlating every result', async () => {
    const f = fixture();
    const response = await call(f.controller.submitRecordingRoute(await admitted()), batch);
    expect(f.ingest).toHaveBeenCalledExactlyOnceWith(authority, batch);
    expect(response).toEqual({
      version: batch.version,
      recordingGeneration: 3,
      currentGeneration: 3,
      scope,
      result: 'processed',
      accepted: 1,
      duplicates: 1,
      rejected: 1,
      results: ingested.results,
      revision: 7,
    });
    expect(f.log).toHaveBeenCalledExactlyOnceWith('evidence.observations_ingested', {
      count: 1,
      outcome: 'ingested',
      reasonCode: 'some_rejected',
    });
    const logged = JSON.stringify(f.log.mock.calls);
    for (const privateValue of [accountId, universeId, exposureId, id(10), 'activeIntervalsMs'])
      expect(logged).not.toContain(privateValue);
  });

  it.each([
    { currentGeneration: 4, reason: 'recording_paused' as const },
    { currentGeneration: 5, reason: 'recording_generation_stale' as const },
  ])('returns a final $reason answer for the original batch without an ingestion claim', async (state) => {
    const f = fixture();
    f.ingest.mockResolvedValue({ kind: 'not_recorded', recordingGeneration: 3, revision: 8, ...state });
    expect(await call(f.controller.submitRecordingRoute(await admitted()), batch)).toEqual({
      version: batch.version,
      recordingGeneration: 3,
      ...state,
      scope,
      revision: 8,
      result: 'not_recorded',
    });
    expect(f.ingest).toHaveBeenCalledExactlyOnceWith(authority, batch);
    expect(f.log).not.toHaveBeenCalled();
  });

  it.each([
    ['batch_too_large', 'PAYLOAD_TOO_LARGE', 413],
    ['invalid_input', 'INVALID_REQUEST', 400],
    ['recording_required', 'RECORDING_GENERATION_REQUIRED', 409],
    ['epoch_changed', 'PRIVACY_EPOCH_CHANGED', 409],
    ['universe_unavailable', 'UNIVERSE_UNAVAILABLE', 403],
  ] as const)('maps the fixed %s refusal without a successful acknowledgement', async (reason, code, status) => {
    const f = fixture();
    f.ingest.mockResolvedValue({ kind: 'refused', reason });
    await expect(call(f.controller.submitRecordingRoute(await admitted()), batch)).rejects.toMatchObject({
      code,
      status,
    });
    expect(f.log).not.toHaveBeenCalled();
  });

  it.each([
    { ...batch, version: undefined },
    { ...batch, recordingGeneration: undefined },
    { ...batch, recordingGeneration: 0 },
    { ...batch, scope },
  ])('refuses malformed/mixed wire input before intake', async (invalid) => {
    const f = fixture();
    // The transport validator, not a backend stub, refuses this input.
    await expect(
      call(f.controller.submitRecordingRoute(await admitted()), invalid as RecordingObservationBatchRequest),
    ).rejects.toBeDefined();
    expect(f.ingest).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled();
  });

  it.each([
    { ...ingested, recordingGeneration: 5 },
    { ...ingested, accepted: 2 },
    { ...ingested, results: [...ingested.results].reverse() },
    { ...ingested, rejected: 0, results: ingested.results.slice(0, 2) },
    {
      kind: 'not_recorded' as const,
      recordingGeneration: 5,
      currentGeneration: 4,
      reason: 'recording_paused' as const,
      revision: 7,
    },
    {
      kind: 'not_recorded' as const,
      recordingGeneration: 3,
      currentGeneration: 3,
      reason: 'recording_generation_stale' as const,
      revision: 7,
    },
  ])('refuses uncorrelated or inconsistent backend output before logging success', async (result) => {
    const f = fixture();
    f.ingest.mockResolvedValue(result);
    await expect(call(f.controller.submitRecordingRoute(await admitted()), batch)).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 500,
    });
    expect(f.log).not.toHaveBeenCalled();
  });

  it('fails closed without the actual guard-admitted caller', async () => {
    const f = fixture();
    await expect(call(f.controller.submitRecordingRoute({} as Request), batch)).rejects.toBeDefined();
    expect(f.ingest).not.toHaveBeenCalled();
  });

  it.each(['invalid_input', 'recording_required'] as const)('maps %s on the legacy route too', async (reason) => {
    const f = fixture();
    f.ingest.mockResolvedValue({ kind: 'refused', reason });
    const request = await admitted('/v1/observations/batch');
    const { version: _version, recordingGeneration: _generation, ...legacy } = batch;
    await expect(call(f.controller.submitRoute(request), legacy)).rejects.toMatchObject({
      code: reason === 'invalid_input' ? 'INVALID_REQUEST' : 'RECORDING_GENERATION_REQUIRED',
    });
    expect(f.log).not.toHaveBeenCalled();
  });
});
