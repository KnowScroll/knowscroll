/**
 * The shared reasoning engine's public surface (blueprint §15, §22): execution machinery and
 * attempt accounting only. Roles (instructions, context, output schema, validator, applier) live
 * in their owning modules and call this. Adapters are bound through `adapters/nest-providers.ts`.
 */
export {
  MAX_STORED_OUTPUT_BYTES,
  ModelRejectedError,
  type AttemptLedger,
  type ExecuteModelStepPorts,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from './application/ports.js';
export {
  makeExecuteModelStep,
  type ExecuteModelStep,
  type ModelStep,
  type ModelStepResult,
} from './application/execute-model-step.js';
