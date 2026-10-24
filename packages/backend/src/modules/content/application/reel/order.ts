import { compileReelRequest, reelScriptDigest } from '../../domain/reel/request.js';
import {
  approvalReference,
  REEL_CEILING_CAP_CENTS,
  type ReelScript,
  type ReelUntil,
} from '../../domain/reel/script.js';
import {
  isOpen,
  poolIdentityOf,
  reconcileAttempt,
  releaseClaim,
  summaryOf,
  type AttemptSummary,
} from './attempt-steps.js';
import { checkAgainstWorld, lintScript, type ScriptRefusal } from './assess.js';
import type { ReelAttemptRecord, ReelOrderRecord, ReelPorts } from './ports.js';

export interface OrderCommand {
  readonly scriptName: string;
  readonly until: ReelUntil;
  /** The most this order may cost, in cents: at most Cutroom's own cap for one Reel. */
  readonly ceilingCents: number;
  /** Try again after an attempt that ended without a Reel. Never implied. */
  readonly retake: boolean;
}

export type OrderRefusalCode =
  | ScriptRefusal['code']
  | 'ceiling_invalid'
  | 'already_published'
  | 'earlier_order_open'
  | 'last_attempt_ended'
  | 'engine_not_ready'
  | 'engine_refused'
  | 'pool_unavailable'
  | 'pool_cap_exceeded'
  | 'pool_already_ordered'
  | 'pool_take_taken'
  | 'attempt_conflict';

export type OrderResult =
  | {
      readonly kind: 'refused';
      readonly code: OrderRefusalCode;
      readonly detail?: unknown;
      readonly attempt?: AttemptSummary;
    }
  /** Cutroom accepted the request. Follow it with `reel follow`. */
  | { readonly kind: 'sent'; readonly attempt: AttemptSummary; readonly replayed: boolean }
  /** The request may or may not have arrived. It is never sent again. */
  | { readonly kind: 'unknown'; readonly attempt: AttemptSummary }
  /** An attempt is already running or waiting to be followed. */
  | { readonly kind: 'in_progress'; readonly attempt: AttemptSummary };

type Next =
  | { readonly kind: 'new' }
  | { readonly kind: 'resume'; readonly attempt: ReelAttemptRecord }
  | { readonly kind: 'reconcile'; readonly attempt: ReelAttemptRecord }
  | { readonly kind: 'in_progress'; readonly attempt: ReelAttemptRecord }
  | {
      readonly kind: 'refused';
      readonly code: OrderRefusalCode;
      readonly detail?: unknown;
      readonly attempt?: ReelAttemptRecord;
    };

const refused = (code: OrderRefusalCode, attempt?: ReelAttemptRecord, detail?: unknown): OrderResult => ({
  kind: 'refused',
  code,
  ...(detail === undefined ? {} : { detail }),
  ...(attempt === undefined ? {} : { attempt: summaryOf(attempt) }),
});

function refusedByScript(refusal: { readonly kind: 'refused' } & ScriptRefusal): OrderResult {
  const { kind: _kind, code, ...detail } = refusal;
  return refused(code, undefined, Object.keys(detail).length === 0 ? undefined : detail);
}

/** Decides from the latest attempt whether to start, continue, look up, or stop. */
function nextStep(order: ReelOrderRecord, attempts: readonly ReelAttemptRecord[], retake: boolean): Next {
  const latest = attempts.at(-1);
  if (order.assetId !== null) return { kind: 'refused', code: 'already_published' };
  if (latest === undefined) return { kind: 'new' };
  const ended = (detail: unknown): Next =>
    retake ? { kind: 'new' } : { kind: 'refused', code: 'last_attempt_ended', detail, attempt: latest };
  switch (latest.state) {
    case 'reserved':
      return { kind: 'resume', attempt: latest };
    case 'not_sent':
      return { kind: 'new' };
    case 'dispatched':
    case 'unknown':
      return { kind: 'reconcile', attempt: latest };
    case 'failed':
    case 'written_off':
      return ended(latest.state);
    case 'succeeded':
    case 'reconciled': {
      const settled = !latest.paid || latest.poolState === 'settled';
      if (latest.finished === null || !settled) return { kind: 'in_progress', attempt: latest };
      return ended(latest.finished.outcome);
    }
  }
}

/**
 * An earlier order under this name, made from different content, whose last attempt has not
 * ended. Changing a script must not leave a request unfollowed and its money unsettled.
 */
async function openEarlierOrder(p: ReelPorts, scriptName: string, until: ReelUntil, scriptSha256: string) {
  const latest = await p.ledger.latestOrderOf(scriptName, until);
  if (latest === undefined || latest.scriptSha256 === scriptSha256 || latest.assetId !== null) return undefined;
  const last = (await p.ledger.attemptsOf(latest.id)).at(-1);
  return last !== undefined && isOpen(last) ? { orderId: latest.id, attempt: last } : undefined;
}

/** The next take: past every take this world and the shared pool already know of. */
async function chooseTake(
  p: ReelPorts,
  attempts: readonly ReelAttemptRecord[],
  scriptSha256: string,
  paid: boolean,
): Promise<number> {
  const local = Math.max(0, ...attempts.map((attempt) => attempt.take)) + 1;
  return paid ? Math.max(local, await p.pool.nextTake(scriptSha256)) : local;
}

/** An open claim, or a Reel already made, on this script in the shared pool. */
async function existingClaim(p: ReelPorts, scriptSha256: string) {
  const orders = await p.pool.orders();
  const held = orders.find(
    (order) =>
      order.scriptSha256 === scriptSha256 &&
      (order.state === 'claimed' || (order.state === 'settled' && order.outcome === 'completed')),
  );
  return held === undefined ? undefined : { requestId: held.requestId, orderedBy: held.orderedBy };
}

/** Ends an attempt that never left. Its claim, if it holds one, goes back to the pool. */
async function abandon(
  p: ReelPorts,
  attempt: ReelAttemptRecord,
  code: OrderRefusalCode,
  detail?: unknown,
): Promise<OrderResult> {
  const closed = (await p.ledger.advance(attempt.id, { kind: 'not_sent', code })) ?? attempt;
  return refused(code, (await releaseClaim(p, closed)) ?? closed, detail);
}

/** Claim before order: the pool must hold this attempt's ceiling before anything is sent. */
async function claimInPool(
  p: ReelPorts,
  order: ReelOrderRecord,
  attempt: ReelAttemptRecord,
): Promise<
  | { readonly kind: 'claimed'; readonly attempt: ReelAttemptRecord }
  | { readonly kind: 'stop'; readonly result: OrderResult }
> {
  let claim;
  try {
    claim = await p.pool.claim(poolIdentityOf(p.world, order, attempt));
  } catch {
    return { kind: 'stop', result: refused('pool_unavailable', attempt) };
  }
  // A claim of ours whose answer was lost comes back as "already ordered" by us.
  const ours = claim.kind === 'already_ordered' && claim.requestId === attempt.requestId && claim.orderedBy === p.world;
  if (claim.kind === 'claimed' || ours) {
    const recorded = await p.ledger.advance(attempt.id, { kind: 'claimed' });
    return recorded
      ? { kind: 'claimed', attempt: recorded }
      : { kind: 'stop', result: refused('attempt_conflict', attempt) };
  }
  if (claim.kind === 'already_ordered')
    return {
      kind: 'stop',
      result: await abandon(p, attempt, 'pool_already_ordered', {
        requestId: claim.requestId,
        orderedBy: claim.orderedBy,
      }),
    };
  const code = claim.kind === 'cap_exceeded' ? 'pool_cap_exceeded' : 'pool_take_taken';
  return { kind: 'stop', result: await abandon(p, attempt, code) };
}

/** Records what Cutroom answered to the one request. A refusal means no run exists. */
async function recordSubmission(
  p: ReelPorts,
  attempt: ReelAttemptRecord,
  answer: Awaited<ReturnType<ReelPorts['engine']['submit']>>,
): Promise<OrderResult> {
  if (answer.kind === 'accepted') {
    const accepted = await p.ledger.advance(attempt.id, { kind: 'accepted', runId: answer.runId });
    return accepted
      ? { kind: 'sent', attempt: summaryOf(accepted), replayed: answer.replayed }
      : { kind: 'in_progress', attempt: summaryOf(attempt) };
  }
  if (answer.kind === 'refused') {
    const failed =
      (await p.ledger.advance(attempt.id, { kind: 'refused', code: `refused_${answer.reason}` })) ?? attempt;
    return refused('engine_refused', (await releaseClaim(p, failed)) ?? failed, answer.reason);
  }
  const unknown = (await p.ledger.advance(attempt.id, { kind: 'unknown', code: answer.code })) ?? attempt;
  return { kind: 'unknown', attempt: summaryOf(unknown) };
}

/**
 * Takes a reserved attempt as far as Cutroom: claim, readiness, one committed dispatch intent, one
 * POST. Each step is recorded before the next, so a crash anywhere leaves a state that the next
 * command resumes or reconciles and never repeats.
 */
async function dispatch(p: ReelPorts, order: ReelOrderRecord, reserved: ReelAttemptRecord): Promise<OrderResult> {
  let attempt = reserved;
  if (attempt.paid && attempt.poolState === 'none') {
    const claimed = await claimInPool(p, order, attempt);
    if (claimed.kind === 'stop') return claimed.result;
    attempt = claimed.attempt;
  }
  if (!(await p.engine.ready())) return abandon(p, attempt, 'engine_not_ready');
  const intent = await p.ledger.advance(attempt.id, { kind: 'dispatching' });
  if (intent === undefined) return { kind: 'in_progress', attempt: summaryOf(attempt) };
  return recordSubmission(p, intent, await p.engine.submit(intent.requestUtf8));
}

async function reconcile(p: ReelPorts, attempt: ReelAttemptRecord): Promise<OrderResult> {
  const looked = await reconcileAttempt(p, attempt);
  if (looked.kind === 'reconciled') return { kind: 'in_progress', attempt: summaryOf(looked.attempt) };
  if (looked.kind === 'unreachable') return refused('engine_not_ready', attempt);
  return { kind: 'unknown', attempt: summaryOf(attempt) };
}

async function startNew(
  p: ReelPorts,
  order: ReelOrderRecord,
  script: ReelScript,
  command: OrderCommand,
  attempts: readonly ReelAttemptRecord[],
): Promise<OrderResult> {
  const latest = attempts.at(-1);
  if (latest?.state === 'not_sent' && (await releaseClaim(p, latest)) === undefined)
    return refused('pool_unavailable', latest);
  const paid = command.until === 'video';
  let take;
  try {
    // Another order of this script, open or already made, means this world only receives it.
    const held = paid ? await existingClaim(p, order.scriptSha256) : undefined;
    if (held !== undefined) return refused('pool_already_ordered', undefined, held);
    take = await chooseTake(p, attempts, order.scriptSha256, paid);
  } catch {
    return refused('pool_unavailable');
  }
  const request = compileReelRequest(
    script,
    { until: command.until, take, ceilingCents: command.ceilingCents },
    p.sha256,
  );
  const reserved = await p.ledger.reserve({
    orderId: order.id,
    take,
    paid,
    requestId: request.requestId,
    requestUtf8: request.requestUtf8,
    requestSha256: request.requestSha256,
    ceilingCents: command.ceilingCents,
  });
  return reserved === undefined ? refused('attempt_conflict') : dispatch(p, order, reserved);
}

/**
 * Orders a Reel from Cutroom, or rehearses it (`until: plan`, which spends nothing and needs no
 * pool claim). Safe to run again: it continues whatever the last attempt left, reconciles an
 * uncertain one, and starts another take only after an attempt ended without a Reel and the
 * operator said `retake`.
 *
 * Authority: an operator in a dev or stage world; the script's approval is part of the script.
 * Side effects: ledger rows, at most one pool claim and at most one POST to Cutroom. Never inside
 * a database transaction.
 * Failure: a pool that cannot be reached stops the order before anything is sent; an uncertain
 * POST is `unknown` and is only ever looked up.
 */
export function makeOrderReel(p: ReelPorts) {
  return async (command: OrderCommand): Promise<OrderResult> => {
    if (
      !Number.isInteger(command.ceilingCents) ||
      command.ceilingCents < 1 ||
      command.ceilingCents > REEL_CEILING_CAP_CENTS
    )
      return refused('ceiling_invalid', undefined, { capCents: REEL_CEILING_CAP_CENTS });
    const linted = lintScript(p, command.scriptName);
    if (linted.kind === 'refused') return refusedByScript(linted);
    const world = await checkAgainstWorld(p, linted.linted);
    if (world.kind === 'refused') return refusedByScript(world);
    const { script } = linted.linted;
    const scriptSha256 = reelScriptDigest(script, command.until, p.sha256);
    const earlier = await openEarlierOrder(p, command.scriptName, command.until, scriptSha256);
    if (earlier !== undefined) return refused('earlier_order_open', earlier.attempt, { orderId: earlier.orderId });
    const order = await p.ledger.ensureOrder({
      scriptName: command.scriptName,
      recipeKey: script.recipe,
      until: command.until,
      scriptSha256,
      approvalRef: approvalReference(script),
      script,
    });
    const attempts = await p.ledger.attemptsOf(order.id);
    const next = nextStep(order, attempts, command.retake);
    switch (next.kind) {
      case 'refused':
        return refused(next.code, next.attempt, next.detail);
      case 'in_progress':
        return { kind: 'in_progress', attempt: summaryOf(next.attempt) };
      case 'reconcile':
        return reconcile(p, next.attempt);
      case 'resume':
        return dispatch(p, order, next.attempt);
      case 'new':
        return startNew(p, order, script, command, attempts);
    }
  };
}
