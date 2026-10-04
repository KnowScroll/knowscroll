/**
 * #164 — the worker's writing loop over shared supply requests (ADR-0046 §3).
 *
 * A pass first settles what can no longer be sent as it is (a request on a route that is no longer
 * enabled; a send a dead worker left unsettled) and decides again every demand still waiting on a
 * settled request. It then takes the oldest open request on the enabled route and runs ADR-0041's
 * steps for it (`write-scroll.ts`: fetch, write, check, admit) with that route's transport. The
 * `beforeSend` gate asks the transport's readiness (for MiniMax, the quota preflight) and then
 * `admitRequest`, which takes one unit of the route's bucket and commits the request as `sending`
 * before the one send: it is never retried. The outcome settles the request, and every waiter's
 * demand gets its own fresh decision.
 */
import type pg from 'pg';
import { transaction } from '@knowscroll/db';
import { redecideForSupply } from '@knowscroll/db/inventory/demand';
import {
  admitRequest,
  nextOpenRequest,
  settleRequest,
  settleStrandedRequests,
  type RequestOutcome,
} from '@knowscroll/db/inventory/supply';
import { writeScroll, type ScrollItemResult } from './write-scroll.ts';
import type { ScrollTransport } from '../providers/transports.ts';

type Transports = Partial<Record<'fixture' | 'minimax', ScrollTransport>>;

/** `done` reports the request as it now stands: `open` when the readiness gate held it back for a later pass. */
export type SupplyPass =
  | { kind: 'idle'; reason: string }
  | { kind: 'done'; requestId: string; status: string; reasons: string[] };

/** How one item's result settles its request; null when the gate did not send it (it either held
 * the request back, still open, or already settled it). */
function outcomeOf(result: ScrollItemResult): RequestOutcome | null {
  switch (result.status) {
    case 'admitted':
      return {
        status: 'fulfilled',
        writingId: result.writingId,
        assetId: result.assetId!,
      };
    case 'already_decided':
      return result.assetId
        ? {
            status: 'fulfilled',
            writingId: result.writingId,
            assetId: result.assetId,
          }
        : {
            status: 'refused',
            writingId: result.writingId,
            reasons: result.reasons,
          };
    case 'refused':
      return {
        status: 'refused',
        writingId: result.writingId,
        reasons: result.reasons,
      };
    case 'failed':
      return { status: 'failed', reasons: result.reasons };
    // `ready` is a dry run's status; a pass always applies.
    case 'not_sent':
    case 'ready':
      return null;
  }
}

export async function runSupplyPass(deps: {
  pool: pg.Pool;
  transports: Transports;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<SupplyPass> {
  const { pool, transports, signal } = deps;
  await settleStrandedRequests(pool);
  await redecideForSupply(pool);
  const request = await nextOpenRequest(pool);
  if (!request) return { kind: 'idle', reason: 'no_open_request' };
  const transport = transports[request.transport];
  if (!transport)
    return {
      kind: 'idle',
      reason: `transport_not_configured:${request.transport}`,
    };

  const result = await writeScroll(
    {
      transport,
      model: request.model,
      apply: true,
      signal,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      async beforeSend(gateSignal) {
        const ready = transport.ready
          ? await transport.ready(gateSignal)
          : { ok: true as const };
        return ready.ok
          ? transaction((client) => admitRequest(client, request.id), pool)
          : ready;
      },
    },
    { url: request.url, conceptCodes: request.offeredCodes },
  );
  const outcome = outcomeOf(result);
  if (outcome)
    await transaction(
      (client) => settleRequest(client, request.id, outcome),
      pool,
    );
  await redecideForSupply(
    pool,
    outcome?.status === 'fulfilled' ? outcome.assetId : null,
  );
  const now = (
    await pool.query<{ status: string; reasons: string[] }>(
      'SELECT status, reasons FROM supply_request WHERE id=$1',
      [request.id],
    )
  ).rows[0]!;
  return {
    kind: 'done',
    requestId: request.id,
    status: now.status,
    reasons: now.status === 'open' ? result.reasons : now.reasons,
  };
}
