import { assertOutsideTransaction } from '../../infrastructure/postgres/transaction-marker.js';
import type { ModelPort } from '../application/ports.js';

/**
 * Wraps any model transport so it refuses to run inside a database transaction. Composition
 * roots wrap every ModelPort (real or fixture) with this before handing it to a use case.
 */
export function guardedModelPort(port: ModelPort): ModelPort {
  return {
    provider: port.provider,
    model: port.model,
    invoke(request, signal) {
      assertOutsideTransaction(`model:${port.provider}`);
      return port.invoke(request, signal);
    },
  };
}
