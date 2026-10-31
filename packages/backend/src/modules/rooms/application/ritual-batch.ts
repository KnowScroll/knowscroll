import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import type { ReadLibraryPassageText, ReadLibraryPassages } from '../../content/public.js';
import {
  alterationProblem,
  citationHolds,
  flawPayload,
  planFlaw,
  seedOf,
  type FlawPlan,
  type Sha256,
} from '../domain/flaw.js';
import { chooseQuestionSource, questionFrom } from '../domain/ritual-question.js';
import { FlawPayloadSchema, QuestionPayloadSchema, RITUAL_VERSION, type RitualKind } from '../domain/rituals.js';
import type { NewRitual, RitualDecision, RitualRoom, RitualRow, RitualStore } from './ritual-ports.js';
import { RITUAL_POLICY_VERSION, RITUAL_ROLE_VERSION, ritualContext, ritualRole, ritualVerdict } from './ritual-role.js';

/** A Scroll a room's item cited within this many days is passed over for another, when another exists. */
const RECENT_DAYS = 14;
/** The most Scrolls one draft reads prose from. */
const SOURCES_READ = 100;

export interface RitualBatchPorts {
  readonly store: RitualStore;
  readonly readPassages: ReadLibraryPassages;
  readonly readPassageText: ReadLibraryPassageText;
  /** The model the worker is configured for; recorded on every model-made item. */
  readonly model: string;
  /** The generation of the `rooms` root this process works under. */
  readonly generation: number;
  /** A run ID that is the same for the same room, day and kind, so a retried batch never pays twice. */
  readonly runIdFor: (roomId: string, day: string, kind: RitualKind) => string;
  readonly newId: () => string;
  readonly sha256: Sha256;
  readonly now: () => Date;
}

export type DraftOutcome =
  /** Stored as a draft, waiting for an operator. */
  | { readonly kind: 'drafted' }
  /** The room already has an item of this kind for the day. */
  | { readonly kind: 'exists' }
  /** The library has nothing under the topic to make it from. */
  | { readonly kind: 'no_source' }
  /** Nothing was stored and no model was asked: a dry run, which shows the passage and the sentence code chose. */
  | { readonly kind: 'dry_run'; readonly plan?: FlawPlan }
  /** The call came to nothing: a refusal, a spent budget, an unusable answer, nothing to alter, or an unknown outcome. */
  | { readonly kind: 'not_made'; readonly reason: string };

export interface RoomDraft {
  readonly room: string;
  readonly day: string;
  readonly question: DraftOutcome;
  readonly flaw: DraftOutcome;
}

export type ReviewRitualResult =
  | { readonly kind: DecisionResult }
  /** The cited Scroll was corrected, withdrawn or held since the item was made, so it cannot be approved. */
  | { readonly kind: 'citation_changed' }
  | { readonly kind: 'invalid' };
type DecisionResult = 'decided' | 'unknown' | 'not_draft';

export interface RitualOperator {
  /**
   * Drafts a room's question and Spot the flaw for a UTC day. Idempotent by (room, day, kind): a kind the room has is
   * left alone and costs nothing, and the model run's ID is fixed by the room and day, so a retry never pays twice. It
   * does not ask whether the room has members: the night's batch picks its rooms by that, and an operator names a room.
   */
  draftRoom(input: {
    readonly room: RitualRoom;
    readonly day: string;
    readonly dryRun: boolean;
    readonly signal: AbortSignal;
  }): Promise<RoomDraft>;
  /** The night's batch: every open room with a member, one after another. Throws after the loop when any room failed, so the job retries. */
  draftAll(input: {
    readonly day: string;
    readonly signal: AbortSignal;
    /** Told which room failed and why, so the job's log names it; the other rooms are still drafted. */
    readonly onRoomFailed?: (slug: string, error: unknown) => void;
  }): Promise<readonly RoomDraft[]>;
  roomBySlug(slug: string): Promise<RitualRoom | undefined>;
  list(
    filter: { readonly state: 'draft' | 'approved' | 'rejected' | undefined },
    limit: number,
  ): Promise<readonly RitualRow[]>;
  review(input: {
    readonly ritualId: string;
    readonly decision: RitualDecision;
    readonly by: string;
  }): Promise<ReviewRitualResult>;
}

/**
 * The room's daily items (R3 A, D-176): a question from a library Scroll's own words (a template, no model call) and Spot
 * the flaw (one call: the model writes only the altered sentence; code chose the passage and the sentence, keeps the
 * Scroll's own words as the key and checks the alteration). Both are stored as drafts that no member sees until an operator
 * approves them, and neither is ever made while someone waits. The model call is the `rooms.ambient-ritual` role on the
 * nonpersonal rooms scope, outside any transaction, on a run whose ID is fixed by the room and day: a repeated batch finds
 * the stored item or the ended run and calls nothing, and an unknown outcome is never sent again.
 */
export function makeRitualOperator(
  p: RitualBatchPorts,
  harness: ProductionReasoningHarness,
  withRoomScope: WithProductionScope,
): RitualOperator {
  const authority: ProductionAuthority = { scopeId: 'rooms', generation: p.generation };
  const close = (runId: string, state: 'completed' | 'failed' | 'cancelled') =>
    withRoomScope(authority, (scope) => harness.closeProductionRun(scope, { runId, state }));

  const draft = (
    room: RitualRoom,
    day: string,
    kind: RitualKind,
    payload: object,
    made: Pick<NewRitual, 'madeBy' | 'roleVersion' | 'model' | 'attemptId'>,
  ): NewRitual => ({ ritualId: p.newId(), roomId: room.roomId, day, kind, payload, ...made, at: p.now() });

  async function draftQuestion(
    room: RitualRoom,
    day: string,
    sources: Awaited<ReturnType<ReadLibraryPassages>>,
    avoid: ReadonlySet<string>,
    seed: number,
    dryRun: boolean,
  ): Promise<{ outcome: DraftOutcome; assetId: string | undefined }> {
    const source = chooseQuestionSource(sources, seed, avoid);
    const payload = source === undefined ? undefined : questionFrom(source);
    if (source === undefined || payload === undefined) return { outcome: { kind: 'no_source' }, assetId: undefined };
    if (dryRun) return { outcome: { kind: 'dry_run' }, assetId: source.assetId };
    const stored = await p.store.insertDraft(
      draft(room, day, 'question', payload, {
        madeBy: 'template',
        roleVersion: undefined,
        model: undefined,
        attemptId: undefined,
      }),
    );
    return { outcome: { kind: stored ? 'drafted' : 'exists' }, assetId: source.assetId };
  }

  async function draftFlaw(
    room: RitualRoom,
    day: string,
    plan: FlawPlan,
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<DraftOutcome> {
    if (dryRun) return { kind: 'dry_run', plan };
    const runId = p.runIdFor(room.roomId, day, 'flaw');
    const outcome = await harness.proposeProduction(
      {
        run: {
          id: runId,
          authority,
          ownerModule: 'rooms',
          purpose: 'ritual-flaw',
          policyVersion: RITUAL_POLICY_VERSION,
        },
        role: ritualRole(plan.original),
        context: ritualContext(plan, runId),
        limits: { allowRepair: true },
      },
      signal,
    );
    const verdict = ritualVerdict(outcome);
    if (verdict.kind !== 'altered') {
      if (verdict.end !== undefined) await close(runId, verdict.end);
      return { kind: 'not_made', reason: verdict.kind === 'failed' ? outcome.kind : 'nothing_to_add' };
    }
    // The harness already refused an alteration that failed the checks; this is the same rule, held where the item is made.
    if (alterationProblem(plan.original, verdict.text) !== undefined) {
      await close(runId, 'failed');
      return { kind: 'not_made', reason: 'invalid_output' };
    }
    const item = draft(room, day, 'flaw', flawPayload(plan, verdict.text), {
      madeBy: 'model',
      roleVersion: RITUAL_ROLE_VERSION,
      model: p.model,
      attemptId: verdict.attemptId,
    });
    // The item and the end of the run commit together, so a crash between them never leaves a paid answer unstored under
    // a closed run, or a stored one under an open run.
    const stored = await withRoomScope(authority, async (scope) => {
      const inserted = await p.store.insertDraftIn(scope, item);
      await harness.closeProductionRun(scope, { runId, state: 'completed' });
      return inserted;
    });
    if (stored.kind !== 'entered') return { kind: 'not_made', reason: stored.refusal.kind };
    return { kind: stored.value ? 'drafted' : 'exists' };
  }

  async function draftRoom(input: {
    room: RitualRoom;
    day: string;
    dryRun: boolean;
    signal: AbortSignal;
  }): Promise<RoomDraft> {
    const { room, day, dryRun, signal } = input;
    const has = await p.store.kindsOn(room.roomId, day);
    const base = { room: room.slug, day };
    if (has.has('question') && has.has('flaw'))
      return { ...base, question: { kind: 'exists' }, flaw: { kind: 'exists' } };
    const sources = await p.readPassages(room.topic, SOURCES_READ);
    if (sources.length === 0) {
      const none: DraftOutcome = { kind: 'no_source' };
      return {
        ...base,
        question: has.has('question') ? { kind: 'exists' } : none,
        flaw: has.has('flaw') ? { kind: 'exists' } : none,
      };
    }
    const seed = seedOf(`${room.roomId}:${day}`, p.sha256);
    const recent = await p.store.recentSources(room.roomId, day, RECENT_DAYS);
    const question: { outcome: DraftOutcome; assetId: string | undefined } = has.has('question')
      ? { outcome: { kind: 'exists' }, assetId: undefined }
      : await draftQuestion(room, day, sources, recent, seed, dryRun);
    if (has.has('flaw')) return { ...base, question: question.outcome, flaw: { kind: 'exists' } };
    // The puzzle is about another Scroll than the question when the library has one.
    const avoid = new Set([...recent, ...(question.assetId === undefined ? [] : [question.assetId])]);
    const plan = planFlaw(sources, seed, p.sha256, avoid);
    const flaw: DraftOutcome =
      plan === undefined ? { kind: 'no_source' } : await draftFlaw(room, day, plan, dryRun, signal);
    return { ...base, question: question.outcome, flaw };
  }

  /** Whether a question's cited Scroll is still a current one that anyone may be served. */
  async function questionStillCited(row: RitualRow): Promise<boolean> {
    const parsed = QuestionPayloadSchema.safeParse(row.payload);
    if (!parsed.success) return false;
    const { assetId, assetRevision } = parsed.data.source;
    // The one Scroll, read by its own address: the check never depends on how many others the room's topic has.
    const sources = await p.readPassages(row.room.topic, 1, { assetId, assetRevision });
    return sources.length === 1;
  }

  /** Whether a puzzle's cited passage still says what it did, read afresh from the Scroll. */
  async function flawStillCited(row: RitualRow): Promise<boolean | 'invalid'> {
    const parsed = FlawPayloadSchema.safeParse(row.payload);
    if (!parsed.success || row.payloadVersion !== RITUAL_VERSION) return 'invalid';
    const { assetId, assetRevision, blockId } = parsed.data.source;
    const text = await p.readPassageText({ assetId, assetRevision, blockId });
    return text !== undefined && citationHolds(text, parsed.data, p.sha256);
  }

  return {
    draftRoom,

    async draftAll({ day, signal, onRoomFailed }) {
      const done: RoomDraft[] = [];
      let failed = 0;
      for (const room of await p.store.roomsWithMembers()) {
        try {
          done.push(await draftRoom({ room, day, dryRun: false, signal }));
        } catch (error) {
          failed += 1;
          onRoomFailed?.(room.slug, error);
        }
      }
      // Everything stored is idempotent, so a retry only finishes what this run could not.
      if (failed > 0) throw new Error(`ROOMS_RITUALS_ROOMS_FAILED: ${String(failed)}`);
      return done;
    },

    roomBySlug: (slug) => p.store.roomBySlug(slug),

    list: (filter, limit) => p.store.list(filter, limit),

    async review({ ritualId, decision, by }) {
      const row = await p.store.one(ritualId);
      if (row === undefined) return { kind: 'unknown' };
      if (row.state !== 'draft') return { kind: 'not_draft' };
      if (decision === 'approved') {
        const holds = row.kind === 'flaw' ? await flawStillCited(row) : await questionStillCited(row);
        if (holds === 'invalid') return { kind: 'invalid' };
        if (!holds) return { kind: 'citation_changed' };
      }
      return { kind: await p.store.decide({ ritualId, decision, by, at: p.now() }) };
    },
  };
}
