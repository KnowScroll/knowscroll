import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import { ObservationsController } from './observations.controller.js';

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
