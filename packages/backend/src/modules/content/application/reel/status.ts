import { reelScriptDigest } from '../../domain/reel/request.js';
import type { ReelUntil } from '../../domain/reel/script.js';
import { summaryOf, type AttemptSummary } from './attempt-steps.js';
import type { PoolBudget, ReelPorts } from './ports.js';

export interface ScriptStatus {
  readonly script: string;
  readonly recipe: string;
  readonly until: ReelUntil;
  /** `null` when this world never ordered the script at this stage. */
  readonly order: null | {
    readonly assetId: string | null;
    readonly attempts: readonly (AttemptSummary & {
      readonly outcome: string | null;
      readonly costCents: number | null;
      readonly detail: string | null;
    })[];
  };
}

export interface ReelStatus {
  readonly world: string;
  readonly engineReady: boolean;
  /** `null` when the pool cannot be read. */
  readonly pool: PoolBudget | null;
  readonly scripts: readonly ScriptStatus[];
}

/**
 * Everything an operator needs to decide the next paid step: the pool's budget, whether Cutroom is
 * ready, and what each shipped script has been through here. Reads only.
 */
export function makeReelStatus(p: ReelPorts) {
  return async (): Promise<ReelStatus> => {
    const [engineReady, pool, orders] = await Promise.all([
      p.engine.ready(),
      p.pool.budget().catch(() => null),
      p.ledger.listOrders(),
    ]);
    const bySha = new Map(orders.map((entry) => [entry.order.scriptSha256, entry]));
    const scripts = [...p.scripts.entries()].flatMap(([name, script]) =>
      (['plan', 'video'] as const).map((until): ScriptStatus => {
        const entry = bySha.get(reelScriptDigest(script, until, p.sha256));
        return {
          script: name,
          recipe: script.recipe,
          until,
          order:
            entry === undefined
              ? null
              : {
                  assetId: entry.order.assetId,
                  attempts: entry.attempts.map((attempt) => ({
                    ...summaryOf(attempt),
                    outcome: attempt.finished?.outcome ?? attempt.outcomeCode,
                    costCents: attempt.finished?.costCents ?? null,
                    detail: attempt.finished?.detail ?? null,
                  })),
                },
        };
      }),
    );
    return { world: p.world, engineReady, pool, scripts };
  };
}
