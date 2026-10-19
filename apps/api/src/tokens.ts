/** Injection tokens of the API composition root. Ports are injected by token, never by class. */
export const API_CONFIG = Symbol('ApiConfig');
export const DATABASE = Symbol('Database');
export const LOG_EVENT = Symbol('LogEvent');
export const WITH_PERSONAL_SCOPE = Symbol('WithPersonalScope');
export const ENQUEUE_JOB = Symbol('EnqueueJob');
export const CALLERS = Symbol('AuthenticatedCallers');
/** `() => RelayState`: the LISTEN relay's current state, for `/health`. */
export const RELAY_STATE = Symbol('RelayState');
