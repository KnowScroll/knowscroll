import { WAIT_LIMIT_MS, commissionSupply, isComing, nextPoll, waitStartOf } from './commission.js';
import { checkedRevision, inventory, snapshot, sourceOf, type SkipExplanations } from './inventory.js';
import type { MatchStep } from './matching.js';
import type { Demand, ResolveRequest, SupplyPorts, UnavailableReason } from './ports.js';
import type { PersonalScopeTx } from '../../identity/public.js';

type Ending =
  | { readonly kind: 'ready' }
  /** Keep waiting; `relink` names the group now standing behind the request when it changed. */
  | { readonly kind: 'wait'; readonly relink?: { readonly workId: string; readonly decision: 'join' | 'create' } }
  | { readonly kind: 'unavailable'; readonly reason: UnavailableReason };

/**
 * A group that commissioned nothing (it was started before Create existed, or it only held demand)
 * cannot deliver. Its waiter commissions as if it had just asked: it joins or starts the group that
 * has work behind it, or is refused for an honest reason.
 */
async function recommission(p: SupplyPorts, scope: PersonalScopeTx, d: Demand): Promise<Ending> {
  const commissioned = await commissionSupply(p, scope, d.brief!, d.planned ? 'planner' : 'person');
  return commissioned.kind === 'waiting'
    ? { kind: 'wait', relink: { workId: commissioned.workId, decision: commissioned.decision } }
    : { kind: 'unavailable', reason: commissioned.reason };
}

/**
 * What a waiter whose content is not admitted yet should do (D-037): keep waiting while the
 * production that serves it is queued or running, within the wait limit; close it when that
 * production ended without serving it; commission it when no production stands behind it at all.
 */
async function waitingOutcome(p: SupplyPorts, scope: PersonalScopeTx, d: Demand): Promise<Ending> {
  const work = d.workId === undefined ? undefined : await p.store.readWork(scope, d.workId);
  if (work?.recipe === undefined) return recommission(p, scope, d);
  const production = await p.readProduction(scope, work.recipe);
  const waited = p.now().getTime() - Date.parse(waitStartOf(d));
  return isComing(production.state) && waited < WAIT_LIMIT_MS
    ? { kind: 'wait' }
    : { kind: 'unavailable', reason: 'could_not_prepare' };
}

/**
 * Planned demand asks for something new, so it binds only to content outside the explanations the
 * person has met, re-derived now under their scope: a Scroll they read since the plan, or one that was
 * already there while the paid job is still queued, must not stand in for what was commissioned.
 */
function skipFor(p: SupplyPorts, scope: PersonalScopeTx, d: Demand): SkipExplanations | undefined {
  if (d.planned === undefined || d.brief?.subject.kind !== 'catalogue') return undefined;
  const topicId = d.brief.subject.topicId;
  return (units) => p.readMetUnits(scope, { topicIds: [topicId], units });
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
    const inventoryNow = await inventory(p, scope, d.command, d.brief, skipFor(p, scope, d));
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
      if (ending.relink)
        await p.store.finish(scope, { ...d, workId: ending.relink.workId, decision: ending.relink.decision });
      await p.enqueue(scope, d.id, nextPoll(d, p.now()));
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
