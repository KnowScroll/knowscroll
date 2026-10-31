import { ROOM_KIT_VERSION, type RoomKit } from '@knowscroll/contracts';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  ReasoningContext,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { Decision, DecisionOutcome, FaceRoom, FaceStore, KitRow } from './face-ports.js';
import { kitIsValid, kitOfDraft } from './kit.js';
import { KIT_POLICY_VERSION, KIT_ROLE_VERSION, kitContext, kitRole, kitVerdict } from './kit-role.js';

export type ProposeKitResult =
  | { readonly kind: 'proposed'; readonly slug: string; readonly revision: number; readonly kit: RoomKit }
  | {
      readonly kind: 'dry_run';
      readonly slug: string;
      readonly revision: number;
      readonly role: string;
      readonly roleVersion: string;
      readonly context: ReasoningContext;
    }
  | { readonly kind: 'unknown_room' }
  /** A proposal is already waiting for review; approve or reject it first. */
  | { readonly kind: 'pending_exists'; readonly revision: number }
  /** The model call came to nothing: a refusal, an exhausted budget, an unusable answer, or an unknown outcome. */
  | { readonly kind: 'not_made'; readonly reason: string };

/** `invalid`: the stored kit no longer passes today's vocabulary and contrast rules, so it cannot be approved. */
export type ReviewKitResult = { readonly kind: DecisionOutcome | 'invalid' };

export interface FaceKitPorts {
  readonly store: FaceStore;
  /** The model the worker is configured for; recorded on the proposal. */
  readonly model: string;
  /** The generation of the `rooms` root this process works under. */
  readonly generation: number;
  /**
   * A run ID that is the same for the same room, revision and sequence, so a retried command never pays twice. A run that
   * ended (closed, or its attempt written off) is over: the next command for the room goes on to the next sequence.
   */
  readonly runIdFor: (roomId: string, revision: number, sequence: number) => string;
  readonly now: () => Date;
}

/** A kit as the operator reads it, with whether it still passes today's rules. */
export interface KitListing extends KitRow {
  readonly valid: boolean;
}

/** How many runs one revision may go through. A run that ended is never reopened, so a failed proposal is asked for again on the next. */
const MAX_RUNS_PER_REVISION = 20;

export interface FaceKitOperator {
  /**
   * Asks the model for a room's kit and stores it as a proposal nobody sees until an operator approves it. A dry run
   * builds the context and stops. One call (plus at most one repair) per proposal, outside any transaction, on a run
   * whose ID is fixed by the room and revision.
   */
  propose(input: { slug: string; dryRun: boolean; signal: AbortSignal }): Promise<ProposeKitResult>;
  list(limit: number): Promise<readonly KitListing[]>;
  review(input: { slug: string; revision: number; decision: Decision; by: string }): Promise<ReviewKitResult>;
}

/**
 * The operator's controls over a room's kit (blueprint §15 "models propose, code validates", D-170). The model call is the
 * `rooms.station-kit` role on the nonpersonal rooms scope; its answer was already refused by the harness unless it was
 * the closed vocabulary with a palette that reads, and it is stored here as a proposal, never shown. Approving is the
 * operator's act; a room without an approved kit wears the default its ID gives it.
 */
export function makeFaceKitOperator(
  p: FaceKitPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): FaceKitOperator {
  const authority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  const close = (runId: string, state: 'completed' | 'failed' | 'cancelled') =>
    withRoomScope(authority, (scope) => harness.closeProductionRun(scope, { runId, state }));

  /**
   * Calls the role on the first run of this revision that is not over. A run that was closed (a failed proposal) or whose attempt
   * was written off is never reopened, so the next command goes on to the next run; a run still open (an unknown outcome) answers
   * from the ledger and is never sent again.
   */
  async function callOnOpenRun(
    room: FaceRoom,
    revision: number,
    context: ReasoningContext,
    role: ReturnType<typeof kitRole>,
    signal: AbortSignal,
  ) {
    for (let sequence = 0; sequence < MAX_RUNS_PER_REVISION; sequence += 1) {
      const runId = p.runIdFor(room.roomId, revision, sequence);
      const outcome = await harness.proposeProduction(
        {
          run: {
            id: runId,
            authority,
            ownerModule: 'rooms',
            purpose: 'station-kit',
            policyVersion: KIT_POLICY_VERSION,
          },
          role,
          context,
          limits: { allowRepair: true },
        },
        signal,
      );
      const over =
        outcome.kind === 'refused' && (outcome.reason === 'run_closed' || outcome.reason === 'attempt_written_off');
      if (!over) return { runId, verdict: kitVerdict(outcome) };
    }
    return undefined;
  }

  return {
    async propose({ slug, dryRun, signal }) {
      const room = await p.store.roomBySlug(slug);
      if (room === undefined) return { kind: 'unknown_room' };
      const { nextRevision, pending } = await p.store.kitState(room.roomId);
      if (pending) return { kind: 'pending_exists', revision: nextRevision - 1 };
      const context = kitContext(room, nextRevision);
      const role = kitRole();
      if (dryRun)
        return { kind: 'dry_run', slug, revision: nextRevision, role: role.id, roleVersion: role.version, context };
      const called = await callOnOpenRun(room, nextRevision, context, role, signal);
      if (called === undefined) return { kind: 'not_made', reason: 'runs_exhausted' };
      const { runId, verdict } = called;
      if (verdict.kind === 'not_made') {
        if (verdict.end !== undefined) await close(runId, verdict.end);
        return { kind: 'not_made', reason: verdict.reason };
      }
      const kit = kitOfDraft(verdict.draft);
      // The proposal and the end of the run commit together, so a crash between them never leaves a paid answer unstored
      // under a closed run or a stored one under an open run.
      const stored = await withRoomScope(authority, async (scope) => {
        const inserted = await p.store.insertKit(scope, {
          roomId: room.roomId,
          revision: nextRevision,
          kit,
          kitVersion: ROOM_KIT_VERSION,
          roleVersion: KIT_ROLE_VERSION,
          model: p.model,
          attemptId: verdict.attemptId,
          at: p.now(),
        });
        await harness.closeProductionRun(scope, { runId, state: 'completed' });
        return inserted;
      });
      if (stored.kind !== 'entered') return { kind: 'not_made', reason: stored.refusal.kind };
      return stored.value
        ? { kind: 'proposed', slug, revision: nextRevision, kit }
        : { kind: 'pending_exists', revision: nextRevision };
    },

    async list(limit) {
      const rows = await p.store.listKits(limit);
      return rows.map((row) => ({ ...row, valid: kitIsValid(row.kit) }));
    },

    async review(input) {
      const row = await p.store.kit(input.slug, input.revision);
      if (row === undefined) return { kind: 'unknown' };
      if (input.decision === 'approved' && !kitIsValid(row.kit)) return { kind: 'invalid' };
      return { kind: await p.store.decideKit({ ...input, at: p.now() }) };
    },
  };
}
