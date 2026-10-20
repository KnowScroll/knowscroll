import { assertOutsideTransaction } from '../../infrastructure/postgres/transaction-marker.js';
import type { GuardedModelPort, ModelPort } from '../application/ports.js';

/**
 * Wraps any model transport so its network operations (`observeQuota`, `send`) refuse to run
 * inside a database transaction (blueprint §19: no model call or network wait inside a
 * transaction). `encode` is pure and is passed through. Composition roots wrap every ModelPort
 * (real or fixture) with this before handing it to the harness; extra properties of the wrapped
 * port (a fixture's call log) are kept.
 */
export function guardedModelPort<P extends ModelPort>(port: P): P & GuardedModelPort {
  // The brand has no runtime presence: this function is the only place that asserts it.
  return {
    ...port,
    provider: port.provider,
    model: port.model,
    encode: (request) => port.encode(request),
    observeQuota(signal) {
      assertOutsideTransaction(`model-quota:${port.provider}`);
      return port.observeQuota(signal);
    },
    send(body, signal) {
      assertOutsideTransaction(`model:${port.provider}`);
      return port.send(body, signal);
    },
  } as P & GuardedModelPort;
}
