/** Private demand use cases; paid commissioning and transport are separate capabilities. */
export type {
  CreateRequest,
  ReadRequest,
  CancelRequest,
  ResolveRequest,
  Result,
  Refusal,
} from './application/ports.js';
export { resolveSupplyQueue, ResolveSupplyJobSchema, type ResolveSupplyJob } from './events.js';
export const CREATE_CONTENT_REQUEST = Symbol('supply.createRequest');
export const READ_CONTENT_REQUEST = Symbol('supply.readRequest');
export const CANCEL_CONTENT_REQUEST = Symbol('supply.cancelRequest');
export const RESOLVE_CONTENT_REQUEST = Symbol('supply.resolveRequest');
