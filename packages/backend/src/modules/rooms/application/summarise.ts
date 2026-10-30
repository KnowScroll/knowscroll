import { HARNESS_PROMPT_VERSION } from '../../../reasoning/public.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ReasoningContext,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { CheckPersonalOwnerActive, PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import { roomAcceptsPosts } from '../domain/membership.js';
import type { SummariseJob } from '../events.js';
import { assembleAway } from './away.js';
import {
  AWAY_MIN_READABLE,
  AWAY_POLICY_VERSION,
  AWAY_ROLE_VERSION,
  awayContext,
  awayRole,
  summaryVerdict,
  type SummaryVerdict,
} from './away-role.js';
import { hasResident, type RoomPorts } from './ports.js';

/** The worker's consumer of `rooms.summarise`. */
export type Summarise = (job: SummariseJob, signal: AbortSignal) => Promise<void>;

export interface SummarisePorts extends RoomPorts {
  readonly ownerActive: CheckPersonalOwnerActive;
  /** The model the worker is configured for; recorded on every summary. */
  readonly model: string;
  /** The generation of the `rooms` root this worker works under. */
  readonly generation: number;
}

/**
 * Step 1, in one transaction: recheck authority and that the summary is still wanted (still queued, the room open, the
 * resident still in the cast), and reduce the window to the bounded context. A summary with too few readable messages
 * ends here without a call: nothing reached the provider, so it is handed back.
 */
async function prepare(
  p: SummarisePorts,
  scope: PersonalScopeTx,
  job: SummariseJob,
): Promise<ReasoningContext | undefined> {
  if (!p.residentsEnabled || !(await p.ownerActive(scope))) return undefined;
  const lock = await p.rooms.lock(scope, job.roomId, 'read');
  if (!lock) return undefined;
  const summary = await p.summaries.read(lock, job.summaryId);
  if (summary?.state !== 'queued') return undefined;
  const room = await p.rooms.roomRow(lock);
  const wanted = roomAcceptsPosts(room.status) && hasResident(room, 'skeptic');
  const material = wanted ? await assembleAway(p, scope, lock, { summary, room }) : undefined;
  if (material === undefined || material.messages.length < AWAY_MIN_READABLE) {
    await p.summaries.settle(lock, summary.summaryId, { state: 'failed', at: p.now(), dispatched: false });
    return undefined;
  }
  return awayContext(material);
}

/**
 * Step 3, in one transaction: store the words if the summary is still queued (a message it read may have been removed
 * meanwhile, which makes it stale and keeps it from being stored), and settle it either way. Returns whether the run
 * may be closed.
 */
async function apply(
  p: SummarisePorts,
  scope: PersonalScopeTx,
  job: SummariseJob,
  verdict: SummaryVerdict,
): Promise<boolean> {
  if (!(await p.ownerActive(scope))) return false;
  const lock = await p.rooms.lock(scope, job.roomId, 'read');
  if (!lock) return false;
  const at = p.now();
  const provenance = {
    roleVersion: AWAY_ROLE_VERSION,
    promptVersion: HARNESS_PROMPT_VERSION,
    model: p.model,
    attemptId: verdict.kind === 'summary' ? verdict.attemptId : undefined,
  };
  if (verdict.kind === 'summary') {
    await p.summaries.settle(lock, job.summaryId, { state: 'ready', at, body: verdict.text, provenance });
    // The room's members read it within seconds, not at the next poll.
    await p.rooms.announce(lock, at);
  } else if (verdict.kind === 'nothing_to_add') {
    await p.summaries.settle(lock, job.summaryId, { state: 'declined', at, provenance });
  } else {
    await p.summaries.settle(lock, job.summaryId, { state: 'failed', at, dispatched: verdict.dispatched });
  }
  return true;
}

/**
 * A resident writes one window's "while you were away" (blueprint §15 "AI inhabitant" role, D-162, D-169): one call per
 * room and window, however many members returned. Three steps, the model call outside any transaction: (1) one
 * transaction rechecks authority and that the summary is still wanted and builds the bounded context (kept-out members
 * and removed messages are not in it); (2) the harness makes one call (plus at most one repair) under the nonpersonal
 * `rooms` scope, as an `ambient` role, on a run whose ID is the summary ID, so a redelivery never pays twice and an
 * unknown outcome is never resent; (3) one transaction stores the words or settles the summary without them, and the run
 * is closed.
 *
 * Authority: the worker acts as a system actor for the universe of the member whose return opened the window, only to
 * take the room lock in order and to stop when that person is gone; the call is paid by the room scope, not by them.
 *
 * Failure/retry: a summary that stopped being wanted is handed back without a call; one made stale during the call is
 * never stored but stays counted; a cap, a quota or a budget refusal stores nothing and shows nothing.
 */
export function makeSummarise(
  p: SummarisePorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): Summarise {
  const roomAuthority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  return async (job, signal) => {
    const authority: PersonalAuthority = {
      universeId: job.universeId,
      privacyEpoch: job.privacyEpoch,
      actor: { kind: 'system', purpose: 'rooms.summarise' },
    };
    const prepared = await p.withScope(authority, (scope) => prepare(p, scope, job));
    if (prepared.kind !== 'entered' || prepared.value === undefined) return;
    const verdict = summaryVerdict(
      await harness.proposeProduction(
        {
          run: {
            id: job.summaryId,
            authority: roomAuthority,
            ownerModule: 'rooms',
            purpose: 'away-summary',
            policyVersion: AWAY_POLICY_VERSION,
          },
          role: awayRole(),
          context: prepared.value,
          limits: { allowRepair: true },
        },
        signal,
      ),
    );
    const applied = await p.withScope(authority, (scope) => apply(p, scope, job, verdict));
    if (applied.kind !== 'entered' || !applied.value || verdict.end === undefined) return;
    const { end } = verdict;
    await withRoomScope(roomAuthority, (scope) =>
      harness.closeProductionRun(scope, { runId: job.summaryId, state: end }),
    );
  };
}
