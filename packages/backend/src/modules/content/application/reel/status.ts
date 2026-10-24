import { reelScriptDigest } from '../../domain/reel/request.js';
import type { ReelUntil } from '../../domain/reel/script.js';
import { isOpen, summaryOf, type AttemptSummary } from './attempt-steps.js';
import type { PoolBudget, ReelPorts } from './ports.js';

export interface OrderStatus {
  readonly script: string;
  readonly until: ReelUntil;
  /** False when the script has been edited since this order: its content is the one that was ordered. */
  readonly current: boolean;
  readonly assetId: string | null;
  readonly attempts: readonly (AttemptSummary & {
    /** Still needs a command or a decision. */
    readonly open: boolean;
    readonly outcome: string | null;
    readonly costCents: number | null;
    readonly detail: string | null;
  })[];
}

export interface ReelStatus {
  readonly world: string;
  readonly engineReady: boolean;
  /** `null` when the pool cannot be read. */
  readonly pool: PoolBudget | null;
  readonly orders: readonly OrderStatus[];
  /** Shipped scripts this world has never ordered or rehearsed. */
  readonly notOrdered: readonly string[];
}

/**
 * Everything an operator needs to decide the next paid step: the pool's budget, whether Cutroom is
 * ready, every order this world made and what became of each attempt, and which scripts are still
 * untouched. Reads only.
 */
export function makeReelStatus(p: ReelPorts) {
  return async (): Promise<ReelStatus> => {
    const [engineReady, pool, entries] = await Promise.all([
      p.engine.ready(),
      p.pool.budget().catch(() => null),
      p.ledger.listOrders(),
    ]);
    const orders = entries.map(({ order, attempts }): OrderStatus => {
      const shipped = p.scripts.get(order.scriptName);
      return {
        script: order.scriptName,
        until: order.until,
        current: shipped !== undefined && reelScriptDigest(shipped, order.until, p.sha256) === order.scriptSha256,
        assetId: order.assetId,
        attempts: attempts.map((attempt) => ({
          ...summaryOf(attempt),
          open: isOpen(attempt),
          outcome: attempt.finished?.outcome ?? attempt.outcomeCode,
          costCents: attempt.finished?.costCents ?? null,
          detail: attempt.finished?.detail ?? null,
        })),
      };
    });
    const ordered = new Set(entries.map((entry) => entry.order.scriptName));
    return {
      world: p.world,
      engineReady,
      pool,
      orders,
      notOrdered: [...p.scripts.keys()].filter((name) => !ordered.has(name)),
    };
  };
}
