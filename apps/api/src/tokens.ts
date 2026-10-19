/** Injection tokens of the API composition root. Ports are injected by token, never by class. */
export const API_CONFIG = Symbol('ApiConfig');
export const DATABASE = Symbol('Database');
export const LOG_EVENT = Symbol('LogEvent');
