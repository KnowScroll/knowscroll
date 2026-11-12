import type { ProposeRecipesResult } from '../../content/public.js';
import type { ProposalResult } from '../domain/gaps.js';

/**
 * What the content module's answer to a proposal means to the gap loop (#674, D-414): recipe keys and codes, never the model's words.
 * Stored recipes are the recipes of the run, however many deliveries stored them. A run that stored nothing is a failed attempt. A
 * refusal that no retry changes is final, and a spent budget pauses. An attempt of unknown outcome, and a refusal of the harness that may
 * have reached the provider, are never resent. A store that was refused after the answer was kept is neither: the same request, sent
 * again, stores the kept answer, so it only pauses.
 */
export function proposalOf(result: ProposeRecipesResult): ProposalResult {
  switch (result.kind) {
    case 'proposed':
      return { kind: 'recipes', runId: result.runId, keys: result.accepted.map((recipe) => recipe.key) };
    case 'already_proposed':
      return { kind: 'recipes', runId: result.runId, keys: result.recipes };
    case 'closed_failed':
      return {
        kind: 'failed',
        runId: result.runId,
        code:
          result.reason === 'nothing_accepted'
            ? 'nothing_accepted'
            : result.reason === 'failed'
              ? 'model_failed'
              : 'closed',
      };
    case 'refused':
      return { kind: 'refused', code: result.reason };
    case 'paused':
      return { kind: 'paused', code: result.code };
    case 'failed':
      if (!result.unknown && !result.closed && ['scope_refused', 'frozen_context_unreadable'].includes(result.code))
        return { kind: 'paused', code: result.code };
      if (result.unknown || !result.closed) return { kind: 'unknown', runId: result.runId, code: result.code };
      return { kind: 'failed', runId: result.runId, code: 'model_failed' };
    case 'dry_run':
      // A dry run is never asked for: it would mean the request was malformed, and nothing was stored.
      return { kind: 'failed', code: 'closed' };
  }
}
