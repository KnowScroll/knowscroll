import { MAX_PROPOSAL_OPERATIONS } from '../domain/policy.js';
import { QUIET_SWEEP, activityChanges, nextQuietAt, withNextQuietAt } from '../domain/quiet.js';
import { SettleQuietJobSchema, type SettleQuietJob } from '../events.js';
import { applyProposal } from './apply.js';
import { prepareGeography } from './context.js';
import type { GeographyPorts } from './ports.js';

/**
 * Why a settle did nothing, or what it did. Codes for logs, never a person's data.
 * - `applied`: activity changed and a delta was written.
 * - `nothing_due`: current support implies no change; only the next check time was stored.
 * - `disabled`: the Cartographer is switched off, so geography does not change.
 * - `not_current`: the universe, epoch, account or recording generation no longer holds. Nothing was written.
 * - `run_active`: a Cartographer run holds the universe, and a delta under it would void its answer.
 * - `support_unreadable`: support could not be read; the sweep is told to wait before trying again.
 * - `refused`: the delta was refused on fresh authority (support changed meanwhile). The sweep tries again.
 */
export type SettleQuietOutcome =
  'applied' | 'nothing_due' | 'disabled' | 'not_current' | 'run_active' | 'support_unreadable' | 'refused';

/** The outcome and how many places changed activity. */
export interface SettleQuietResult {
  readonly outcome: SettleQuietOutcome;
  readonly changed: number;
}

/** Worker consumer of `geography.settle-quiet`. */
export type SettleQuiet = (job: unknown) => Promise<SettleQuietResult>;

/** Worker consumer of the scheduled `geography.sweep-quiet`. */
export type SweepQuiet = () => Promise<{ readonly handedOver: number }>;

/** Dependencies of the settle: the geography ports and the Cartographer switch. No model harness. */
export interface SettleQuietPorts extends GeographyPorts {
  readonly enabled: () => boolean;
}

/** Discovery of due universes; the adapter hands each over in the same transaction. */
export interface QuietSweepStore {
  /**
   * Looks at the first `limit` universes whose `next_quiet_at` has passed, oldest first, in one
   * transaction. Each that can be settled now (no run holds it, its account is active, nothing is
   * being cleared, recording is on) gets one settle and its `next_quiet_at` moves to `leaseUntil`.
   * Each that cannot moves to `parkUntil`, so a refused universe never stays at the head of the index.
   * Skips rows another transaction holds. Returns how many were handed over.
   */
  handOverDue(input: {
    readonly now: Date;
    readonly limit: number;
    readonly leaseUntil: Date;
    readonly parkUntil: Date;
  }): Promise<number>;
}

export interface SweepQuietPorts {
  readonly enabled: () => boolean;
  readonly now: () => Date;
  readonly store: QuietSweepStore;
}

/**
 * Scheduled pass (D-104). One indexed query for the oldest due universes, bounded to a batch whether
 * or not they can be settled. It reads no support and calls no model; the settle does the work for
 * each universe. It writes nothing but each looked-at universe's own `next_quiet_at`. With the
 * Cartographer switched off it does nothing.
 */
export function makeSweepQuiet(p: SweepQuietPorts): SweepQuiet {
  return async () => {
    if (!p.enabled()) return { handedOver: 0 };
    const now = p.now();
    const handedOver = await p.store.handOverDue({
      now,
      limit: QUIET_SWEEP.batch,
      leaseUntil: new Date(now.getTime() + QUIET_SWEEP.leaseMs),
      parkUntil: new Date(now.getTime() + QUIET_SWEEP.parkMs),
    });
    return { handedOver };
  };
}

/**
 * Settles one universe's places by the rules and nothing else: the Cartographer's activity rule
 * (`activityChanges`) applied to current support, in a short transaction with no model call and no
 * network wait. Inactivity changes a place's activity, never its existence, id, label or origin.
 *
 * Authority: runs as a system actor under the personal root lock and rechecks the account, the epoch
 * and the recording generation the sweep saw, as the Cartographer's worker does. Recording paused or
 * restarted, a Clear, a suspended or deleted account: nothing is written, and the sweep finds the
 * universe again within a day once it is current. Lock order: personal root, then the owned Geography, Personal
 * Context and Evidence rows, the same as a Cartographer run.
 *
 * Side effects: when activity changed, one immutable delta with no run, the revision stamps, a
 * scene-projection job and a publish job, in the same transaction. When it did not, only the stored
 * `nextQuietAt`. Safe to run twice or late: a second delivery finds nothing to change.
 */
export function makeSettleQuiet(p: SettleQuietPorts): SettleQuiet {
  return async (input) => {
    const job = SettleQuietJobSchema.parse(input);
    if (!p.enabled()) return { outcome: 'disabled', changed: 0 };
    const entered = await p.withScope(
      {
        universeId: job.universeId,
        privacyEpoch: job.privacyEpoch,
        actor: { kind: 'system', purpose: 'geography.settle-quiet' },
      },
      (scope) => settleUnderScope(p, scope, job),
    );
    return entered.kind === 'entered' ? entered.value : { outcome: 'not_current', changed: 0 };
  };
}

async function settleUnderScope(
  p: SettleQuietPorts,
  scope: Parameters<GeographyPorts['store']['state']>[0],
  job: SettleQuietJob,
): Promise<SettleQuietResult> {
  if ((await p.fenceOwn(scope)).kind !== 'active') return { outcome: 'not_current', changed: 0 };
  const gate = await p.fenceRecording(scope, job.recordingGeneration);
  if (gate.kind !== 'recording') return { outcome: 'not_current', changed: 0 };
  const state = await p.store.state(scope);
  // A run that froze its context at today's revision would be voided by a delta committed under it.
  if (state.activeRunId) return { outcome: 'run_active', changed: 0 };
  const context = await prepareGeography(p, gate.scope, await p.store.view(scope));
  if (!context) {
    const retryAt = new Date(p.now().getTime() + QUIET_SWEEP.parkMs).toISOString();
    await p.store.writeState(scope, withNextQuietAt(state, retryAt));
    return { outcome: 'support_unreadable', changed: 0 };
  }
  const operations = activityChanges(context.facts).slice(0, MAX_PROPOSAL_OPERATIONS);
  if (!operations.length) {
    await p.store.writeState(scope, withNextQuietAt(state, nextQuietAt(context.facts)));
    return { outcome: 'nothing_due', changed: 0 };
  }
  const applied = await applyProposal(
    p,
    gate.scope,
    undefined,
    context,
    { version: 'cartographer-proposal.v1', operations },
    () => Promise.resolve(),
  );
  return applied.kind === 'refused'
    ? { outcome: 'refused', changed: 0 }
    : { outcome: 'applied', changed: operations.length };
}
