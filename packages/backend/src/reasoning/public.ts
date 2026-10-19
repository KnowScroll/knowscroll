/**
 * The shared reasoning engine's public surface (blueprint §15, §22): execution machinery and
 * attempt accounting only. Roles (instructions, context, output schema, validator, applier) live
 * in their owning modules and call this.
 */
export { ModelRejectedError, type ModelPort, type ModelRequest, type ModelResponse } from './application/ports.js';
export {
  makeExecuteModelStep,
  type ExecuteModelStep,
  type ModelStep,
  type ModelStepResult,
} from './application/execute-model-step.js';
export { admitRun, findAttempt, reserveAttempt, transitionAttempt } from './adapters/postgres-ledger.js';
export { guardedModelPort } from './adapters/guarded-model.js';
