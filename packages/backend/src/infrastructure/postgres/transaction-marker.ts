import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A runtime marker for "this code runs inside one of our database transactions". It carries no
 * transaction (transactions are always passed explicitly); it only lets boundaries refuse work
 * that must never happen inside a transaction (blueprint §19 "Authority and locking").
 */
const marker = new AsyncLocalStorage<{ readonly purpose: string }>();

/** Raised when a model, provider, media or other network adapter is called inside a transaction. */
export class NetworkInTransactionError extends Error {
  override readonly name = 'NetworkInTransactionError';
  readonly code = 'NETWORK_IN_TRANSACTION';
}

/** Raised when a guarded transaction is opened inside another one. */
export class NestedTransactionError extends Error {
  override readonly name = 'NestedTransactionError';
  readonly code = 'NESTED_TRANSACTION';
}

/** Runs `fn` marked as inside a transaction opened for `purpose`. Refuses nesting. */
export function runMarkedTransaction<T>(purpose: string, fn: () => Promise<T>): Promise<T> {
  if (marker.getStore() !== undefined)
    return Promise.reject(new NestedTransactionError(`${purpose} opened inside another transaction`));
  return marker.run({ purpose }, fn);
}

/** True while the current async context is inside a marked transaction. */
export function insideTransaction(): boolean {
  return marker.getStore() !== undefined;
}

/**
 * Network adapters call this first. Throws `NetworkInTransactionError` when called inside a
 * transaction, so a model call or upload can never hold a lock or a pooled connection.
 */
export function assertOutsideTransaction(adapter: string): void {
  if (insideTransaction()) throw new NetworkInTransactionError(`${adapter} called inside a database transaction`);
}
