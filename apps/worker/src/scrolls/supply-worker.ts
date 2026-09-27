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
import { transaction } from '../../../../packages/db/src/index.ts';
import { redecideForSupply } from '../../../../packages/db/src/inventory/demand.ts';
import { admitRequest, nextOpenRequest, settleRequest, settleStrandedRequests, type RequestOutcome } from '../../../../packages/db/src/inventory/supply.ts';
import { createMiniMaxAnswerTransport } from '../providers/minimax-answer.ts';
import { createFixtureScrollTransport, SCROLL_FIXTURE_MODES, type ScrollFixtureMode } from '../providers/scroll-fixture.ts';
import type { AnswerTransport } from '../reasoning/answer-worker.ts';
import { writeScroll, type ScrollItemResult, type ScrollTransport } from './write-scroll.ts';

type Transports = Partial<Record<'fixture' | 'minimax', ScrollTransport>>;

/** `done` reports the request as it now stands: `open` when the readiness gate held it back for a later pass. */
export type SupplyPass =
  | { kind: 'idle'; reason: string }
  | { kind: 'done'; requestId: string; status: string; reasons: string[] };

/**
 * Which Scroll-writing transport this worker process may use. Configured only from the worker's own
 * environment: KS_SCROLL_TRANSPORT=fixture|minimax (unset: supply requests are not written).
 * `minimax` needs a subscription (`sk-cp-`) key in MINIMAX_API_KEY; when answers already use MiniMax,
 * that same client (and so the same quota readiness) serves Scroll writing too.
 */
export function scrollTransportsFromEnvironment(env: NodeJS.ProcessEnv, answers?: Partial<Record<'fixture' | 'minimax', AnswerTransport>> | null): Transports | null {
  const kind = env.KS_SCROLL_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_SCROLL_FIXTURE_MODE picks the reply the fixture should produce.
    const mode = (env.KS_SCROLL_FIXTURE_MODE ?? 'scroll') as ScrollFixtureMode;
    if (!SCROLL_FIXTURE_MODES.includes(mode)) throw new Error('Unknown KS_SCROLL_FIXTURE_MODE');
    return { fixture: createFixtureScrollTransport(() => mode) };
  }
  if (kind === 'minimax') {
    if (answers?.minimax) return { minimax: answers.minimax };
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey) throw new Error('KS_SCROLL_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment');
    // The transport itself refuses anything but a subscription (sk-cp-) key.
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_SCROLL_TRANSPORT must be fixture or minimax');
}

/** How one item's result settles its request; null when the gate did not send it (it either held
 * the request back, still open, or already settled it). */
function outcomeOf(result: ScrollItemResult): RequestOutcome | null {
  switch (result.status) {
    case 'admitted': return { status: 'fulfilled', writingId: result.writingId, assetId: result.assetId! };
    case 'already_decided': return result.assetId
      ? { status: 'fulfilled', writingId: result.writingId, assetId: result.assetId }
      : { status: 'refused', writingId: result.writingId, reasons: result.reasons };
    case 'refused': return { status: 'refused', writingId: result.writingId, reasons: result.reasons };
    case 'failed': return { status: 'failed', reasons: result.reasons };
    // `ready` is a dry run's status; a pass always applies.
    case 'not_sent': case 'ready': return null;
  }
}

export async function runSupplyPass(deps: { pool: pg.Pool; transports: Transports; signal: AbortSignal; fetchImpl?: typeof fetch; now?: () => Date }): Promise<SupplyPass> {
  const { pool, transports, signal } = deps;
  await settleStrandedRequests(pool);
  await redecideForSupply(pool);
  const request = await nextOpenRequest(pool);
  if (!request) return { kind: 'idle', reason: 'no_open_request' };
  const transport = transports[request.transport];
  if (!transport) return { kind: 'idle', reason: `transport_not_configured:${request.transport}` };

  const result = await writeScroll({
    transport, model: request.model, apply: true, signal, fetchImpl: deps.fetchImpl, now: deps.now,
    async beforeSend(gateSignal) {
      const ready = transport.ready ? await transport.ready(gateSignal) : { ok: true as const };
      return ready.ok ? transaction(client => admitRequest(client, request.id), pool) : ready;
    },
  }, { url: request.url, conceptCodes: request.offeredCodes });
  const outcome = outcomeOf(result);
  if (outcome) await transaction(client => settleRequest(client, request.id, outcome), pool);
  await redecideForSupply(pool, outcome?.status === 'fulfilled' ? outcome.assetId : null);
  const now = (await pool.query<{ status: string; reasons: string[] }>('SELECT status, reasons FROM supply_request WHERE id=$1', [request.id])).rows[0]!;
  return { kind: 'done', requestId: request.id, status: now.status, reasons: now.status === 'open' ? result.reasons : now.reasons };
}
