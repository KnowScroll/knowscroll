import { MAX_PROPOSAL_OPERATIONS } from '../domain/policy.js';
import { QUIET_SWEEP, activityChanges } from '../domain/quiet.js';
import { SettleQuietJobSchema, type SettleQuietJob } from '../events.js';
import { applyProposal, commitEvaluation } from './apply.js';
import { evaluationOf, prepareGeography, topicsOfPlaces } from './context.js';
import type { GeographyPorts } from './ports.js';

/**
 * Why a settle did nothing, or what it did. Codes for logs, never a person's data.
 * - `applied`: activity changed and a delta was written.
 * - `nothing_due`: current support implies no change; only the next check time was stored.
 * - `disabled`: the Cartographer is switched off, so geography does not change.
 * - `not_current`: the universe, epoch, account or recording generation no longer holds. Nothing was written.
 * - `run_active`: a Cartographer run holds the universe, and a delta under it would void its answer.
 * - `support_unreadable`: support could not be read; the places wait before they are tried again.
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

/** Discovery of due places; the adapter hands each universe's over in the same transaction. */
export interface QuietSweepStore {
  /**
   * Looks at the first `limit` places whose `quiet_check_at` has passed, oldest first, across universes, in one
   * transaction. The places of each universe that can be settled now (no run holds it, its account is active, nothing
   * is being cleared, recording is on) go to its settles, at most `QUIET_SWEEP.placesPerSettle` each, and their
   * `quiet_check_at` moves to `leaseUntil`. The places of each that cannot move to `parkUntil`, so a refused place never
   * stays at the head of the index. Skips rows another transaction holds. Returns how many places were handed over.
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
 * Scheduled pass (D-104, D-416). One indexed query for the oldest due places across universes, bounded to a batch
 * whether or not they can be settled. It reads no support and calls no model; the settle does the work for each
 * universe. It writes nothing but each looked-at place's own `quiet_check_at`. With the Cartographer switched off it
 * does nothing.
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
 * Settles the named places of one universe by the rules and nothing else: the Cartographer's activity rule
 * (`activityChanges`) applied to current support of just those places' topics, in a short transaction with no model
 * call and no network wait. Inactivity changes a place's activity, never its existence, id, label or origin.
 *
 * Authority: runs as a system actor under the personal root lock and rechecks the account, the epoch
 * and the recording generation the sweep saw, as the Cartographer's worker does. Recording paused or
 * restarted, a Clear, a suspended or deleted account: nothing is written, and the sweep finds the
 * places again within a day once the universe is current. Lock order: personal root, then the owned Geography, Personal
 * Context and Evidence rows, the same as a Cartographer run.
 *
 * Side effects: when activity changed, one immutable delta with no run, the revision stamps, a
 * scene-projection job and a publish job, in the same transaction. Either way each place it read gets its last support
 * and next look stored, and a place it could not read waits a day. It never clears a dirty topic: a creation that is due
 * belongs to the run that owns it. Safe to run twice or late: a second delivery finds nothing to change.
 */
export function makeSettleQuiet(p: SettleQuietPorts): SettleQuiet {
  return async (input) => {
    const job = SettleQuietJobSchema.parse(input);
    if (!p.enabled()) return { outcome: 'disabled', changed: 0 };
    // A job queued before per-place quiet names no place; the sweep finds the due places again.
    if (job.v === 1) return { outcome: 'not_current', changed: 0 };
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
  job: Extract<SettleQuietJob, { readonly v: 2 }>,
): Promise<SettleQuietResult> {
  if ((await p.fenceOwn(scope)).kind !== 'active') return { outcome: 'not_current', changed: 0 };
  const gate = await p.fenceRecording(scope, job.recordingGeneration);
  if (gate.kind !== 'recording') return { outcome: 'not_current', changed: 0 };
  const state = await p.store.state(scope);
  // A run that froze its context at today's revision would be voided by a delta committed under it.
  if (state.activeRunId) return { outcome: 'run_active', changed: 0 };
  const wait = new Date(p.now().getTime() + QUIET_SWEEP.parkMs);
  const places = await p.store.placesById(scope, job.objectIds);
  const topics = await topicsOfPlaces(p, scope, places);
  const prepared = await prepareGeography(p, gate.scope, { kind: 'topics', topics });
  if (prepared.kind !== 'prepared') {
    await p.store.deferQuiet(scope, job.objectIds, wait);
    return { outcome: 'support_unreadable', changed: 0 };
  }
  const { context } = prepared;
  // A place whose topic was not read (it has no support, or the catalogue lost it) keeps what it has and is looked at again later.
  const read = new Set(context.facts.objects.map((place) => place.id));
  const unread = job.objectIds.filter((id) => !read.has(id));
  const operations = activityChanges(context.facts).slice(0, MAX_PROPOSAL_OPERATIONS);
  let result: SettleQuietResult;
  if (!operations.length) {
    await commitEvaluation(p, scope, context.facts, evaluationOf(context), { clearDirty: false });
    result = { outcome: 'nothing_due', changed: 0 };
  } else {
    const applied = await applyProposal(
      p,
      gate.scope,
      undefined,
      context,
      { version: 'cartographer-proposal.v1', operations },
      () => Promise.resolve(),
      { clearDirty: false },
    );
    result =
      applied.kind === 'refused'
        ? { outcome: 'refused', changed: 0 }
        : { outcome: 'applied', changed: operations.length };
  }
  if (unread.length) await p.store.deferQuiet(scope, unread, wait);
  return result;
}
