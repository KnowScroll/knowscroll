import { WAIT_LIMIT_MS, nextPoll } from './commission.js';
import { checkedRevision, inventory, sourceOf, snapshot } from './inventory.js';
import type { MatchStep } from './matching.js';
import type { Demand, ResolveRequest, SupplyPorts, UnavailableReason } from './ports.js';
import type { PersonalScopeTx } from '../../identity/public.js';

type Ending =
  | { readonly kind: 'ready' }
  | { readonly kind: 'wait' }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/**
 * What a waiter whose content is not admitted yet should do (D-037): keep waiting while the
 * production that serves it is queued or running, within the wait limit; close it when that
 * production ended without serving it, or when no production stands behind it at all.
 */
async function waitingOutcome(p: SupplyPorts, scope: PersonalScopeTx, d: Demand): Promise<Ending> {
  const work = d.workId === undefined ? undefined : await p.store.readWork(scope, d.workId);
  if (work?.recipe === undefined) return { kind: 'unavailable', reason: 'budget_unavailable' };
  const production = await p.readProduction(scope, work.recipe);
  const stillComing = production === 'not_started' || production === 'running';
  const waited = p.now().getTime() - Date.parse(d.createdAt);
  return stillComing && waited < WAIT_LIMIT_MS
    ? { kind: 'wait' }
    : { kind: 'unavailable', reason: 'could_not_prepare' };
}

/**
 * Advances one waiter and tells the caller whether a free-text match is still due. One recipient per
 * transaction: no shared-work lock is held while acquiring any other root, and the owner, epoch,
 * source and the content's current admission are all rechecked here, never trusted from the job.
 */
async function advanceWaiter(
  p: SupplyPorts,
  authority: Parameters<SupplyPorts['withScope']>[0],
  requestId: string,
): Promise<'done' | 'needs_match'> {
  const entered = await p.withScope(authority, async (scope) => {
    if (!(await p.ownerActive(scope))) return 'done';
    const d = await p.store.read(scope, requestId);
    if (d?.status === 'matching') return 'needs_match';
    if (!d || (d.status !== 'requested' && d.status !== 'deferred') || !d.brief) return 'done';
    const inventoryNow = await inventory(p, scope, d.command, d.brief);
    const current = await snapshot(p, scope, d);
    const source = sourceOf(d.command);
    const validSource =
      !source ||
      (inventoryNow.sourceHead?.encounter &&
        (await p.checkSource(scope, {
          exposureId: source.exposureId,
          assetId: source.assetId,
          assetRevision: source.assetRevision,
        })));
    if (!(await p.ownerActive(scope))) return 'done';
    const ready = validSource ? inventoryNow.ready : undefined;
    const ending: Ending = ready?.encounter
      ? { kind: 'ready' }
      : validSource
        ? await waitingOutcome(p, scope, d)
        : { kind: 'unavailable', reason: 'source_unavailable' };
    if (ending.kind === 'wait') {
      await p.enqueue(scope, d.id, nextPoll(d.createdAt, p.now()));
      return 'done';
    }
    const revision = await p.advance(scope);
    const next: Demand = {
      ...d,
      revision,
      requestRevision: checkedRevision(current.requestRevision + 1),
      updatedAt: p.now().toISOString(),
      status: ending.kind === 'ready' ? 'ready' : 'unavailable',
      reason: ending.kind === 'unavailable' ? ending.reason : undefined,
      ...(ready?.encounter && ending.kind === 'ready'
        ? { content: ready.encounter, contentAvailabilityRevision: ready.availabilityRevision }
        : {}),
      ...(inventoryNow.sourceHead ? { sourceAvailabilityRevision: inventoryNow.sourceHead.availabilityRevision } : {}),
    };
    await p.store.finish(scope, next);
    if (d.workId) await p.store.closeWork(scope, d.workId);
    await p.notify(scope, revision, d.id);
    return 'done';
  });
  return entered.kind === 'entered' ? entered.value : 'done';
}

/**
 * The `supply.resolve-request` consumer's use case. A waiter first gets its free-text ask matched
 * (when the worker provides a matcher), then waits for production by looking again every
 * {@link WAIT_POLL_MS} until its content is admitted or its production ended. Every look is a fresh
 * authority check; a redelivery changes nothing that is already decided.
 */
export function makeResolveRequest(p: SupplyPorts, match?: MatchStep): ResolveRequest {
  return async (job, delivery) => {
    const authority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'supply.resolve' },
    } as const;
    if ((await advanceWaiter(p, authority, job.requestId)) === 'needs_match' && match)
      await match(job, delivery?.signal ?? new AbortController().signal);
  };
}
