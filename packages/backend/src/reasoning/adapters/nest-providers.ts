/**
 * Reusable outer wiring of the reasoning engine (blueprint §22): the PostgreSQL attempt ledger and
 * the transaction guard every model transport must be wrapped in. Composition roots (and
 * integration tests) only. No role uses the engine in S1.2; S2.2 adds the first real transport.
 */
export { guardedModelPort } from './guarded-model.js';
export { makeAttemptLedger } from './postgres-ledger.js';
