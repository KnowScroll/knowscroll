import type { MadeToOrderScroll, RecordMadeToOrderScroll } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';

const UTC_DAY_MS = 86_400_000;

/** What a thread's chosen branch asks Quartermaster to produce: the code-built order and the thread it is for. */
export interface ScenarioOrder {
  readonly threadId: string;
  readonly order: MadeToOrderScroll;
}

export type ScenarioOrderOutcome =
  /** The order is recorded and its production job is sent in the caller's transaction. */
  | { readonly kind: 'commissioned'; readonly recipe: string }
  /** The world's day is full (or scenario Create is off), or the thread has had all the branches it may. */
  | { readonly kind: 'refused'; readonly reason: 'day_cap' | 'thread_cap' };

/** Quartermaster's ledger of scenario orders: names no person and no words, only the counts the caps read. */
export interface ScenarioOrderStore {
  /** Takes the lock that serialises Create decisions, so a day's count and the orders it admits agree. */
  lockCommissioning(scope: PersonalScopeTx): Promise<void>;
  exists(scope: PersonalScopeTx, orderId: string): Promise<boolean>;
  countSince(scope: PersonalScopeTx, since: Date): Promise<number>;
  countForThread(scope: PersonalScopeTx, threadId: string): Promise<number>;
  insert(scope: PersonalScopeTx, order: { readonly orderId: string; readonly threadId: string }): Promise<void>;
}

export interface ScenarioOrderPorts {
  readonly store: ScenarioOrderStore;
  readonly recordOrder: RecordMadeToOrderScroll;
  /** Sends the production job of one take of a recipe in the caller's transaction (idempotent per recipe, version and take). */
  readonly enqueueProduction: (scope: PersonalScopeTx, recipe: string, take: number) => Promise<void>;
  /** Branches Create may order per UTC day (0 turns it off) and per thread over its life. */
  readonly caps: { readonly perDay: number; readonly perThread: number };
  readonly now: () => Date;
}

export type CommissionScenarioOrder = (scope: PersonalScopeTx, input: ScenarioOrder) => Promise<ScenarioOrderOutcome>;

/**
 * Quartermaster's Create for a thread's chosen branch (blueprint §11, §14; D-049). The brief was built
 * by code from the validated node, so nothing here reads words or matches the order to anyone else's:
 * an order is its own work, never joined, never reused for another thread. Two caps bound the spend,
 * each counted from this ledger: the world's day, and the thread's life. An order the ledger already
 * holds is commissioned again without counting twice, so a retry cannot spend the day.
 *
 * Authority: runs inside the caller's open personal scope, after the caller's gate and the thread's
 * lock. The commissioning lock follows them and is last in the lock order. No model call or network
 * wait happens here: production runs later in a worker.
 */
export function makeCommissionScenarioOrder(p: ScenarioOrderPorts): CommissionScenarioOrder {
  return async (scope, input) => {
    await p.store.lockCommissioning(scope);
    const known = await p.store.exists(scope, input.order.orderId);
    if (!known) {
      const startOfDay = new Date(Math.floor(p.now().getTime() / UTC_DAY_MS) * UTC_DAY_MS);
      if ((await p.store.countSince(scope, startOfDay)) >= p.caps.perDay) return { kind: 'refused', reason: 'day_cap' };
      if ((await p.store.countForThread(scope, input.threadId)) >= p.caps.perThread)
        return { kind: 'refused', reason: 'thread_cap' };
    }
    const { recipe } = await p.recordOrder(scope, input.order);
    if (!known) await p.store.insert(scope, { orderId: input.order.orderId, threadId: input.threadId });
    await p.enqueueProduction(scope, recipe, 1);
    return { kind: 'commissioned', recipe };
  };
}
