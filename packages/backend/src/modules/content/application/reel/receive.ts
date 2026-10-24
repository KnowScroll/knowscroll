import { foldChain } from '../../domain/reel/chain.js';
import { compileReelRequest, reelScriptDigest } from '../../domain/reel/request.js';
import { readChain } from './attempt-steps.js';
import { lintScript } from './assess.js';
import { publishFinishedReel } from './publish-step.js';
import type { ReelPorts } from './ports.js';

export type ReceiveResult =
  | {
      readonly kind: 'refused';
      readonly code:
        | 'script_unknown'
        | 'script_findings'
        | 'repetition'
        | 'not_ordered'
        | 'still_running'
        | 'pool_unavailable'
        | 'body_differs'
        | 'engine_unreachable'
        | 'chain_differs';
    }
  | { readonly kind: 'held'; readonly code: string }
  /** The Reel exists in this world: `created` is false when an earlier run already admitted it. */
  | { readonly kind: 'received'; readonly assetId: string; readonly created: boolean; readonly orderedBy: string }
  /** The Reel was made but cannot be published here, and this world pays nothing for it. */
  | { readonly kind: 'reel_refused'; readonly code: string };

/**
 * Brings in a Reel another world already ordered and paid for. It costs nothing: the shared pool
 * says which request made the Reel, this world rebuilds that request from the same script and
 * checks it byte for byte against the pool's record, reads Cutroom's finished runs, and publishes
 * the Reel exactly as the ordering world did. No claim, no POST, no pool write.
 *
 * Authority: an operator in a dev or stage world. Failure: anything not ready yet is `held` or
 * `refused` with a code; running it again after the cause is gone is always safe.
 */
export function makeReceiveReel(ports: ReelPorts) {
  return async (command: { readonly scriptName: string }): Promise<ReceiveResult> => {
    const linted = lintScript(ports, command.scriptName);
    if (linted.kind === 'refused')
      return {
        kind: 'refused',
        code: linted.code === 'script_unknown' || linted.code === 'repetition' ? linted.code : 'script_findings',
      };
    const { script } = linted.linted;
    const scriptSha256 = reelScriptDigest(script, 'video', ports.sha256);
    let orders;
    try {
      orders = (await ports.pool.orders()).filter((order) => order.scriptSha256 === scriptSha256);
    } catch {
      return { kind: 'refused', code: 'pool_unavailable' };
    }
    const made = orders.find((order) => order.state === 'settled' && order.outcome === 'completed');
    if (made === undefined)
      return {
        kind: 'refused',
        code: orders.some((order) => order.state === 'claimed') ? 'still_running' : 'not_ordered',
      };
    const request = compileReelRequest(
      script,
      { until: 'video', take: made.take, ceilingCents: made.ceilingCents },
      ports.sha256,
    );
    if (request.requestId !== made.requestId || request.requestSha256 !== made.requestSha256)
      return { kind: 'refused', code: 'body_differs' };
    const found = await ports.engine.lookup(made.requestId);
    if (found.kind !== 'found') return { kind: 'refused', code: 'engine_unreachable' };
    const chain = await readChain(ports, found.status.runId);
    if (chain.kind !== 'chain') return { kind: 'refused', code: 'engine_unreachable' };
    const report = foldChain(made.requestId, chain.runs);
    if (report.kind !== 'finished' || report.outcome !== 'completed' || report.finalRunId !== made.finalRunId)
      return { kind: 'refused', code: 'chain_differs' };
    const published = await publishFinishedReel(ports, {
      linted: linted.linted,
      origin: { kind: 'received', orderedBy: made.orderedBy, take: made.take, ceilingCents: made.ceilingCents },
      requestId: made.requestId,
      runs: chain.runs,
      report,
    });
    if (published.kind === 'held') return { kind: 'held', code: published.code };
    if (published.kind === 'refused') return { kind: 'reel_refused', code: published.code };
    return { kind: 'received', assetId: published.assetId, created: published.created, orderedBy: made.orderedBy };
  };
}
