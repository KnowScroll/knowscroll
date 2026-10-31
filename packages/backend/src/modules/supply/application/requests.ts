import {
  CreateContentRequestSchema,
  ContentRequestReceiptSchema,
  CancelContentRequestSchema,
  CancelContentRequestReceiptSchema,
  ReadContentRequestSchema,
  RetryContentRequestSchema,
  RetryContentRequestReceiptSchema,
} from '@knowscroll/contracts';
import type { CreateContentRequest } from '@knowscroll/contracts';
import { CONCEPTS, type ScrollAskFacts } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { MAX_OPEN_REQUESTS, MAX_RETRIES, commissionSupply } from './commission.js';
import { commissionAskOrder } from './ask-orders.js';
import { reopenedAskOrder } from './ask-retry.js';
import { isSuggestedQuestion } from '../domain/ask-order.js';
import { briefOf, checkedRevision, inventory, snapshot, sourceOf } from './inventory.js';
import type {
  SupplyPorts,
  Demand,
  CreateRequest,
  ReadRequest,
  CancelRequest,
  RetryRequest,
  RecordPlannedDemand,
} from './ports.js';

/** A free-text ask with no encounter context: the one kind of ask that waits for a catalogue match. */
function asksFreeText(c: CreateContentRequest): boolean {
  return (
    c.language === 'en' &&
    c.intent.kind === 'topic' &&
    c.intent.subject.kind === 'text' &&
    c.intent.context === undefined
  );
}

type AskIntent = Extract<CreateContentRequest['intent'], { kind: 'ask' }>;

/**
 * What a fresh ask from here becomes. A question the Scroll itself suggests (its exact authored words) is about that
 * Scroll by construction, so its ask order is made now with no model call. Any other question waits to be placed: a
 * worker asks the scope step whether it is about this Scroll or names another subject.
 */
async function askDemand(
  p: SupplyPorts,
  scope: PersonalScopeTx,
  demand: Demand,
  ask: AskIntent,
  facts: ScrollAskFacts,
): Promise<Demand> {
  if (!isSuggestedQuestion(ask.question, facts.suggestions))
    return { ...demand, status: 'matching', decision: 'pending', reason: undefined };
  const commissioned = await commissionAskOrder(p, scope, { source: ask.source, facts, question: ask.question });
  return commissioned.kind === 'commissioned'
    ? { ...demand, status: 'requested', decision: 'create', reason: undefined, askOrder: commissioned.order }
    : { ...demand, reason: commissioned.reason };
}

export function makeCreateRequest(p: SupplyPorts): CreateRequest {
  return async (authority, command) => {
    const c = CreateContentRequestSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      const previous = await p.receipts.find(scope, 'supply.create', c.commandId, c);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: ContentRequestReceiptSchema.parse({
            ...ContentRequestReceiptSchema.parse(previous.outcome),
            replayed: true,
          }),
        } as const;
      if (previous.kind !== 'new') return { kind: 'refused', reason: previous.reason } as const;
      // Every open ask is polled by its own jobs, so the number a person may have open is bounded. A refusal
      // writes no receipt: the same command can be sent again once an ask ends or is cancelled.
      if ((await p.store.countOpenPersonDemands(scope)) >= MAX_OPEN_REQUESTS)
        return { kind: 'refused', reason: 'too_many_open' } as const;
      const ask = c.intent.kind === 'ask' ? c.intent : undefined;
      if (ask) {
        // An ask from here is tied to what the person has read, so it needs recording on (D-083).
        const gate = await p.fenceRecording(scope, ask.recordingGeneration);
        if (gate.kind === 'paused') return { kind: 'refused', reason: 'recording_paused' } as const;
        if (gate.kind === 'stale') return { kind: 'refused', reason: 'recording_stale' } as const;
        if (gate.kind !== 'recording') return { kind: 'refused', reason: 'scope_refused' } as const;
      }
      const source = sourceOf(c);
      if (source && !(await p.checkSource(scope, source))) return { kind: 'refused', reason: 'stale_source' } as const;
      // The anchor must be a stop of the exact revision the person is reading, whose words are the writer's context.
      const askFacts = ask
        ? await p.readAskFacts(scope, ask.source, ask.anchor.stopId)
        : undefined;
      if (ask && !askFacts) return { kind: 'refused', reason: 'source_unavailable' } as const;
      // This preliminary immutable read grants no authority; one sorted lock batch below
      // rechecks current admission after waiting before any receipt or private mutation.
      const preliminary = source ? await p.readExact(scope, { ...source, capabilities: c.capabilities }) : undefined;
      const brief = briefOf(c, preliminary);
      const current = await inventory(p, scope, c, brief);
      if (source && (!(await p.checkSource(scope, source)) || !current.sourceHead?.encounter))
        return { kind: 'refused', reason: 'source_unavailable' } as const;
      const id = p.newId(),
        now = p.now().toISOString();
      await p.receipts.insert(scope, 'supply.create', c.commandId, c);
      let demand: Demand = {
        id,
        command: c,
        status: 'unavailable',
        decision: 'refuse',
        reason: 'unsupported_request',
        requestRevision: 1,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        ...(current.sourceHead ? { sourceAvailabilityRevision: current.sourceHead.availabilityRevision } : {}),
      };
      if (brief && current.ready?.encounter)
        demand = {
          ...demand,
          brief,
          status: 'ready',
          decision: 'reuse',
          reason: undefined,
          content: current.ready.encounter,
          contentAvailabilityRevision: current.ready.availabilityRevision,
        };
      else if (brief) {
        const commissioned = await commissionSupply(p, scope, brief, 'person');
        demand =
          commissioned.kind === 'waiting'
            ? {
                ...demand,
                brief,
                status: 'requested',
                reason: undefined,
                workId: commissioned.workId,
                decision: commissioned.decision,
              }
            : { ...demand, brief, reason: commissioned.reason };
      } else if (ask && askFacts) demand = await askDemand(p, scope, demand, ask, askFacts);
      else if (asksFreeText(c)) demand = { ...demand, status: 'matching', decision: 'pending', reason: undefined };
      const revision = await p.advance(scope);
      await p.store.insert(scope, { ...demand, revision });
      if (demand.status === 'requested' || demand.status === 'matching') await p.enqueue(scope, id);
      const receipt = ContentRequestReceiptSchema.parse({
        version: 'content-request-receipt.v1',
        commandId: c.commandId,
        requestId: id,
        recordedAt: now,
        privacyEpoch: scope.authority.privacyEpoch,
        revision,
        replayed: false,
        outcome: 'accepted',
      });
      await p.receipts.complete(scope, c.commandId, receipt);
      await p.notify(scope, revision, id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeReadRequest(p: SupplyPorts): ReadRequest {
  return async (authority, input) => {
    const c = ReadContentRequestSchema.parse(input);
    const result = await p.withScope(authority, async (scope) => {
      const d = await p.store.read(scope, c.requestId);
      return d
        ? ({ kind: 'ok', value: await snapshot(p, scope, d) } as const)
        : ({ kind: 'refused', reason: 'not_found' } as const);
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
export function makeCancelRequest(p: SupplyPorts): CancelRequest {
  return async (authority, command) => {
    const c = CancelContentRequestSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      const previous = await p.receipts.find(scope, 'supply.cancel', c.commandId, c);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: CancelContentRequestReceiptSchema.parse({
            ...CancelContentRequestReceiptSchema.parse(previous.outcome),
            replayed: true,
          }),
        } as const;
      if (previous.kind !== 'new') return { kind: 'refused', reason: previous.reason } as const;
      const d = await p.store.read(scope, c.requestId);
      if (!d) return { kind: 'refused', reason: 'not_found' } as const;
      const current = await snapshot(p, scope, d),
        now = p.now().toISOString();
      await p.receipts.insert(scope, 'supply.cancel', c.commandId, c);
      const revision = await p.advance(scope);
      const outcome =
        current.status === 'cancelled'
          ? 'already_cancelled'
          : current.status === 'preparing'
            ? 'cancelled'
            : 'already_closed';
      if (outcome === 'cancelled')
        await p.store.finish(scope, {
          ...d,
          status: 'cancelled',
          reason: undefined,
          revision,
          requestRevision: checkedRevision(current.requestRevision + 1),
          updatedAt: now,
        });
      // A pending row can already project unavailable after a shared Content withdrawal.
      // Respect that public outcome and freeze its own terminal state, rather than rename it
      // cancelled or allow a later resolver to revive it after this already_closed receipt.
      if (
        (d.status === 'requested' || d.status === 'deferred' || d.status === 'matching') &&
        current.status === 'unavailable'
      )
        await p.store.finish(scope, {
          ...d,
          status: 'unavailable',
          reason: current.reason,
          revision,
          requestRevision: checkedRevision(current.requestRevision + 1),
          updatedAt: now,
        });
      const receipt = CancelContentRequestReceiptSchema.parse({
        version: 'content-request-cancel-receipt.v1',
        commandId: c.commandId,
        requestId: c.requestId,
        recordedAt: now,
        privacyEpoch: scope.authority.privacyEpoch,
        revision,
        replayed: false,
        outcome,
      });
      await p.receipts.complete(scope, c.commandId, receipt);
      await p.notify(scope, revision, d.id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}
/**
 * Tries a request again that closed as "could not prepare": the same request ID and words, a new
 * wait. It re-decides the brief the way Create does (Reuse, then Join or Create), so it respects the
 * day's Create cap, the open-request limit and the recipes still left; it can resend no paid attempt.
 * A free-text ask that was never matched has no brief and is not retried: its model attempt may have
 * had an outcome nobody saw, and unknown outcomes are never resent. Everything else that cannot be
 * retried (already open, cancelled, closed for another reason, retries used, nothing can start now) is
 * answered with an immutable receipt that leaves the request as it was.
 *
 * Authority: the person's own request, under their personal scope. Lock order is Create's: personal
 * root, Content's locks, then the commissioning lock. Side effects: one receipt, the revision and a
 * hint; on `retrying` also the reopened row and one resolver job, in the same transaction.
 */
export function makeRetryRequest(p: SupplyPorts): RetryRequest {
  return async (authority, command) => {
    const c = RetryContentRequestSchema.parse(command);
    const result = await p.withScope(authority, async (scope) => {
      const previous = await p.receipts.find(scope, 'supply.retry', c.commandId, c);
      if (previous.kind === 'replay')
        return {
          kind: 'ok',
          value: RetryContentRequestReceiptSchema.parse({
            ...RetryContentRequestReceiptSchema.parse(previous.outcome),
            replayed: true,
          }),
        } as const;
      if (previous.kind !== 'new') return { kind: 'refused', reason: previous.reason } as const;
      const d = await p.store.read(scope, c.requestId);
      if (!d || d.planned) return { kind: 'refused', reason: 'not_found' } as const;
      // Content's locks first (as Create and the resolver take them), then the current status.
      const current = d.brief ? await inventory(p, scope, d.command, d.brief) : undefined;
      const status = await snapshot(p, scope, d);
      const retryable =
        (d.brief !== undefined || d.askOrder !== undefined) &&
        status.status === 'unavailable' &&
        status.reason === 'could_not_prepare' &&
        (d.retries ?? 0) < MAX_RETRIES;
      let outcome: 'retrying' | 'already_open' | 'not_retryable' =
        status.status === 'preparing' || status.status === 'ready' ? 'already_open' : 'not_retryable';
      let reopened: Demand | undefined;
      if (retryable && d.askOrder) {
        if ((await p.store.countOpenPersonDemands(scope)) >= MAX_OPEN_REQUESTS)
          return { kind: 'refused', reason: 'too_many_open' } as const;
        reopened = await reopenedAskOrder(
          p,
          scope,
          { ...d, askOrder: d.askOrder },
          checkedRevision(status.requestRevision + 1),
        );
        if (reopened) outcome = 'retrying';
      } else if (retryable && current && d.brief) {
        // The ask still counts against the person's open asks once it is open again.
        if ((await p.store.countOpenPersonDemands(scope)) >= MAX_OPEN_REQUESTS)
          return { kind: 'refused', reason: 'too_many_open' } as const;
        const source = sourceOf(d.command);
        if (source && !(await p.checkSource(scope, source)))
          return { kind: 'refused', reason: 'stale_source' } as const;
        if (source && !current.sourceHead?.encounter) return { kind: 'refused', reason: 'source_unavailable' } as const;
        const now = p.now().toISOString();
        const reopenedFields = {
          ...d,
          requestRevision: checkedRevision(status.requestRevision + 1),
          updatedAt: now,
          waitStartedAt: now,
          retries: (d.retries ?? 0) + 1,
          reason: undefined,
          ...(current.sourceHead ? { sourceAvailabilityRevision: current.sourceHead.availabilityRevision } : {}),
        };
        if (current.ready?.encounter)
          reopened = {
            ...reopenedFields,
            status: 'ready',
            decision: 'reuse',
            workId: undefined,
            content: current.ready.encounter,
            contentAvailabilityRevision: current.ready.availabilityRevision,
          };
        else {
          const commissioned = await commissionSupply(p, scope, d.brief, 'person');
          if (commissioned.kind === 'waiting')
            reopened = {
              ...reopenedFields,
              status: 'requested',
              decision: commissioned.decision,
              workId: commissioned.workId,
              content: undefined,
              contentAvailabilityRevision: undefined,
            };
        }
        if (reopened) outcome = 'retrying';
      }
      await p.receipts.insert(scope, 'supply.retry', c.commandId, c);
      const revision = await p.advance(scope);
      if (reopened) {
        await p.store.reopen(scope, { ...reopened, revision });
        if (reopened.status === 'requested') await p.enqueue(scope, reopened.id);
      }
      const receipt = RetryContentRequestReceiptSchema.parse({
        version: 'content-request-retry-receipt.v1',
        commandId: c.commandId,
        requestId: c.requestId,
        recordedAt: p.now().toISOString(),
        privacyEpoch: scope.authority.privacyEpoch,
        revision,
        replayed: false,
        outcome,
      });
      await p.receipts.complete(scope, c.commandId, receipt);
      await p.notify(scope, revision, d.id);
      return { kind: 'ok', value: receipt } as const;
    });
    return result.kind === 'entered' ? result.value : { kind: 'refused', reason: 'scope_refused' };
  };
}

/**
 * The Planner's missing-supply opportunity becomes private demand. The brief is built exactly like
 * a person's catalogue ask, so Reuse and Join/Create follow the same deterministic rules. Where Create
 * starts or joins production, the demand waits as `deferred` and a resolver job binds it when the
 * Scroll is admitted. Where nothing can start (the day's cap, Create switched off, or no recipe left),
 * nothing is stored: a later plan asks again. No receipt is written (the caller's accepted plan is
 * the idempotency boundary) and no client hint is sent (planned demand is not a request the person made).
 */
export function makeRecordPlannedDemand(p: SupplyPorts): RecordPlannedDemand {
  return async (scope, input) => {
    const topicId = input.topicIds.find((id) => CONCEPTS.some((topic) => topic.id === id));
    if (topicId === undefined) return { kind: 'unsupported' };
    const command: CreateContentRequest = {
      version: 'content-request.v1',
      commandId: p.newId(),
      intent: {
        kind: 'topic',
        subject: { kind: 'catalogue', catalogueVersion: 'content-concepts.v1', topicId },
        format: input.format,
      },
      language: input.language,
      capabilities: input.capabilities,
    };
    const brief = briefOf(command, undefined);
    if (!brief) return { kind: 'unsupported' };
    const id = p.newId(),
      now = p.now().toISOString();
    const demand: Demand = {
      id,
      command,
      brief,
      planned: { runId: input.plannerRunId, slot: input.slot },
      requestRevision: 1,
      revision: scope.revisionAtEntry,
      createdAt: now,
      updatedAt: now,
      status: 'deferred',
      decision: 'join',
    };
    const reusable = (await inventory(p, scope, command, brief, new Set(input.alreadyMet))).ready;
    // Plan after plan may ask for the same thing. One open waiter per brief is enough: a deferred one
    // is still waiting, and a ready one still has content to bind.
    const open = await p.store.findOpenPlanned(scope, brief);
    if (open && (open.state === 'deferred' || reusable?.encounter))
      return { kind: 'already_recorded', requestId: open.id };
    if (reusable?.encounter) {
      await p.store.insert(scope, {
        ...demand,
        status: 'ready',
        decision: 'reuse',
        content: reusable.encounter,
        contentAvailabilityRevision: reusable.availabilityRevision,
      });
      return { kind: 'ready', requestId: id };
    }
    const commissioned = await commissionSupply(p, scope, brief, 'planner');
    if (commissioned.kind === 'unavailable') return { kind: 'not_commissioned' };
    await p.store.insert(scope, { ...demand, workId: commissioned.workId, decision: commissioned.decision });
    await p.enqueue(scope, id);
    return { kind: 'deferred', requestId: id, joined: commissioned.decision === 'join' };
  };
}
