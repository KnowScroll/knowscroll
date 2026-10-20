import { productionTransactionOf } from '../../infrastructure/postgres/production-scope.js';
import type { ReadProductionRunAccounting } from '../application/production.js';
import type { AttemptState } from '../domain/attempts.js';

/**
 * Read only the current generation's bounded accounting identities, using the capability's own
 * transaction. Expired/forged capabilities fail at transactionOf. A run from another generation
 * is unavailable even when its immutable ledger remains for settlement. No payload columns are
 * selected, and exceeding the bound is a refusal instead of silently incomplete usage totals.
 */
export const readProductionRunAccounting: ReadProductionRunAccounting = async (scope, runId) => {
  const tx = productionTransactionOf(scope);
  const root = await tx
    .selectFrom('reasoning.production_scopes')
    .select(['enabled', 'generation'])
    .where('id', '=', scope.authority.scopeId)
    .executeTakeFirst();
  if (root?.enabled !== true || root.generation !== scope.authority.generation)
    return { kind: 'refused', reason: 'generation_changed' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(runId)) return { kind: 'not_found' };
  const run = await tx
    .selectFrom('reasoning.production_runs')
    .select('id')
    .where('scope_id', '=', scope.authority.scopeId)
    .where('id', '=', runId)
    .where('generation', '=', scope.authority.generation)
    .executeTakeFirst();
  if (run === undefined) return { kind: 'not_found' };
  const rows = await tx
    .selectFrom('reasoning.production_attempts as attempt')
    // The retained receipt also owns usage reported after a write-off. The attempt remains
    // immutable in that case, so reading its token columns would under-report current usage.
    .leftJoin('reasoning.usage_receipts as receipt', 'receipt.attempt_id', 'attempt.id')
    .select([
      'attempt.id',
      'attempt.step',
      'attempt.state',
      'attempt.provider',
      'attempt.model',
      'receipt.input_tokens',
      'receipt.output_tokens',
      'receipt.reasoning_tokens',
      'receipt.cached_tokens',
    ])
    .where('attempt.scope_id', '=', scope.authority.scopeId)
    .where('attempt.run_id', '=', runId)
    .orderBy('attempt.reserved_at')
    .orderBy('attempt.id')
    .limit(33)
    .execute();
  if (rows.length > 32) return { kind: 'refused', reason: 'accounting_limit' };
  return {
    kind: 'accounted',
    attempts: rows.map((row) => ({
      attemptId: row.id,
      step: row.step,
      state: row.state as AttemptState,
      provider: row.provider,
      model: row.model,
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        reasoningTokens: row.reasoning_tokens,
        cachedTokens: row.cached_tokens,
      },
    })),
  };
};
