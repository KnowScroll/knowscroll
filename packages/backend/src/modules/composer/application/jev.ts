import { z } from 'zod';
import {
  HARNESS_PROMPT_VERSION,
  proposeWhenRecording,
  type PersonalRecordingPurpose,
  type ReasoningContext,
  type ReasoningRole,
  type RecordingReasoningHarness,
  type RunOwner,
} from '../../../reasoning/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { JEV_SHORTLIST_LIMIT } from '../domain/jev.js';
import { refKey } from '../domain/policy.js';
import type { EncounterRef, JevCriteria, SemanticAssessments } from '../domain/types.js';

export const JEV_ROLE_ID = 'composer.jev';
/** Changes with the instructions or the output schema. Recorded on every run and stored assessment. */
export const JEV_ROLE_VERSION = 'jev.2';
export const JEV_POLICY_VERSION = 'composer-jev.v0';
/** The role version and the harness framing version together name the instructions an assessment answered. */
export const JEV_ASSESSMENT_VERSION = `${JEV_ROLE_VERSION}/${HARNESS_PROMPT_VERSION}`;

const Score = z.number().min(0).max(1);
const JevOutputSchema = z.strictObject({
  assessments: z
    .array(
      z.strictObject({ ref: z.string().min(1).max(8), relevance: Score, appropriateness: Score, redundancy: Score }),
    )
    .min(1)
    .max(JEV_SHORTLIST_LIMIT),
});
type JevOutput = z.infer<typeof JevOutputSchema>;

const INSTRUCTIONS = [
  'You help choose what a learner explores next. The context has one current_step item, which is what the learner is on now, and several candidate items, which could come next.',
  'Judge each candidate on three separate criteria. Each is a number from 0 to 1.',
  "- relevance: how well the candidate continues the learner's current interest as shown by the current step. 1 is directly on the same subject, 0 is unrelated.",
  '- appropriateness: how suitable the candidate is as the next explanation: a sensible next idea, neither a repeat nor a leap the learner is not ready for. 1 is a very natural next step.',
  '- redundancy: how much the candidate repeats the current step. 1 means it says essentially the same thing, 0 means it adds something new.',
  'An item may also say its kind (Reel or Scroll), how much it asks of the reader, its reading time, its place in a series and the common myth it corrects. These describe the item. They are not criteria: never score an item up or down for them alone.',
  'Two items that correct the same common myth are redundant with each other: when a candidate corrects the myth the current step corrects, its redundancy is high.',
  "A candidate in the current step's series is never offered, so do not reward or penalise a candidate for being in a series. Judge it as a new subject.",
  'Judge only the text you are given. Do not use outside knowledge about the learner. Do not rank or choose; only score.',
  'Answer with one JSON object {"assessments":[{"ref":"c1","relevance":0.8,"appropriateness":0.7,"redundancy":0.1}, ...]} with one entry for each candidate ref, using exactly the refs given.',
].join('\n');

/** The role's structural contract; the content of an answer is validated by {@link acceptAssessments}. */
export const JEV_ROLE: ReasoningRole<JevOutput> = {
  id: JEV_ROLE_ID,
  version: JEV_ROLE_VERSION,
  instructions: INSTRUCTIONS,
  outputSchema: JevOutputSchema,
  // Adaptive-thinking models spend part of this budget thinking (D-031); the answer is ~40 tokens per candidate.
  maxOutputTokens: 4096,
  // Runs because the person swiped, not because they asked: it stops at the background share of the budgets.
  budgetClass: 'background',
  minContextItems: 2,
};

const ITEM_TEXT_LIMIT = 900;

/** What a play level means to a reader, in the words the model is given. Never a result of anyone's play. */
const PLAY_LEVEL_WORDS = {
  plain: 'nothing to play',
  stage: 'a picture that changes as you read, or a single question to call',
  game: 'several questions to call, ending in a final one',
} as const;

/**
 * One item of the context. Public facts of the content only (D-193): the kind, how much play it has, its
 * reading time, its place in a series and the myth it corrects. Nothing about any reader's play: which
 * option anyone picked, whether it was right, sparks and tiers never reach a model (D-063). The structural
 * lines come first and the summary takes what is left of the limit, so a long summary never cuts the myth.
 */
function describe(encounter: EncounterSnapshot): string {
  const traits = encounter.traits;
  const minutes =
    traits?.readingMinutes === undefined ? '' : `, about ${String(Math.max(1, Math.round(traits.readingMinutes)))} min`;
  const lines = [
    `Title: ${encounter.metadata.title}`,
    `Kind: ${encounter.kind}, ${PLAY_LEVEL_WORDS[traits?.playLevel ?? 'plain']}${minutes}`,
    ...(encounter.series && traits?.seriesTotal
      ? [`Series: part ${String(encounter.series.part)} of ${String(traits.seriesTotal)}`]
      : []),
    ...(traits?.misconceptionClaim ? [`Corrects the common myth: ${traits.misconceptionClaim}`] : []),
    ...(encounter.facets.length ? [`Facets: ${encounter.facets.join(', ')}`] : []),
  ];
  const fixed = lines.join('\n');
  const summaryRoom = Math.max(0, ITEM_TEXT_LIMIT - fixed.length - '\nSummary: '.length);
  return `${fixed}\nSummary: ${encounter.metadata.summary.slice(0, summaryRoom)}`.slice(0, ITEM_TEXT_LIMIT);
}

/** A shortlist as model context. Candidates get short refs so the answer never echoes long identifiers. */
export interface JevRequestContext {
  readonly context: ReasoningContext;
  readonly candidatesByRef: ReadonlyMap<string, EncounterRef>;
}

export function jevContext(source: EncounterSnapshot, shortlist: readonly EncounterSnapshot[]): JevRequestContext {
  const candidates = shortlist.slice(0, JEV_SHORTLIST_LIMIT);
  const candidatesByRef = new Map(
    candidates.map((c, index) => [`c${String(index + 1)}`, { assetId: c.assetId, assetRevision: c.assetRevision }]),
  );
  return {
    candidatesByRef,
    context: {
      bundleRef: `composer-jev:${source.assetId}@${String(source.assetRevision)}`,
      items: [
        { ref: 'step', kind: 'current_step', text: describe(source) },
        ...candidates.map((c, index) => ({ ref: `c${String(index + 1)}`, kind: 'candidate', text: describe(c) })),
      ],
    },
  };
}

/**
 * Keeps the answer's entries that name a candidate we asked about, once each. Unknown or repeated
 * refs are dropped, never guessed at; a candidate with no entry is simply not assessed.
 */
export function acceptAssessments(
  output: JevOutput,
  candidatesByRef: ReadonlyMap<string, EncounterRef>,
): readonly (EncounterRef & JevCriteria)[] {
  const accepted = new Map<string, EncounterRef & JevCriteria>();
  for (const entry of output.assessments) {
    const candidate = candidatesByRef.get(entry.ref);
    if (!candidate || accepted.has(refKey(candidate))) continue;
    accepted.set(refKey(candidate), {
      ...candidate,
      relevance: entry.relevance,
      appropriateness: entry.appropriateness,
      redundancy: entry.redundancy,
    });
  }
  return [...accepted.values()];
}

/** How the business run should end when the result is applied; absent when it must stay open. */
export type JevRunEnd = 'completed' | 'failed' | 'cancelled';

/**
 * What Jev made of a shortlist. `purpose` is the proof the run was made under; the step that applies the result closes the run
 * with it (and only under the recording fence). It is absent when no run was started (recording was paused).
 */
export type JevResult =
  | {
      readonly kind: 'assessed';
      readonly entries: readonly (EncounterRef & JevCriteria)[];
      readonly end: JevRunEnd;
      readonly purpose?: PersonalRecordingPurpose;
    }
  | {
      readonly kind: 'absent';
      readonly reason: string;
      readonly end?: JevRunEnd;
      readonly purpose?: PersonalRecordingPurpose;
    };

export interface AssessShortlist {
  (request: {
    /** The queue job's ID: stable across deliveries, so a redelivery answers from the attempt ledger. */
    readonly runId: string;
    readonly authority: PersonalAuthority;
    readonly source: EncounterSnapshot;
    readonly shortlist: readonly EncounterSnapshot[];
    /** Who the run is for and the generation recording was at when the buffer job started; absent while recording is paused. */
    readonly owner: RunOwner | undefined;
    readonly signal: AbortSignal;
  }): Promise<JevResult>;
}

/**
 * Jev: a fast optional semantic assessment of a shortlist (blueprint §9). It runs only in the
 * buffer worker and never inside a database transaction, on the recording-aware harness at the generation recording was at
 * when the buffer job started (D-268). Provider failure, refusal or an unusable answer is the absence of an assessment, never a
 * negative judgement, and so is a paused recording: no run is started and no model is called.
 */
export function makeAssessShortlist(harness: RecordingReasoningHarness): AssessShortlist {
  return async ({ runId, authority, source, shortlist, owner, signal }) => {
    const { context, candidatesByRef } = jevContext(source, shortlist);
    const { outcome, purpose } = await proposeWhenRecording(
      harness,
      owner,
      {
        run: {
          id: runId,
          authority,
          ownerModule: 'composer',
          purpose: 'jev-assessment',
          policyVersion: JEV_POLICY_VERSION,
        },
        role: JEV_ROLE,
        context,
        limits: { allowRepair: false },
      },
      signal,
    );
    const proof = purpose === undefined ? {} : { purpose };
    switch (outcome.kind) {
      case 'proposed':
        return {
          kind: 'assessed',
          entries: acceptAssessments(outcome.output, candidatesByRef),
          end: 'completed',
          ...proof,
        };
      case 'invalid_output':
        return { kind: 'absent', reason: 'invalid_output', end: 'failed', ...proof };
      case 'failed':
        return { kind: 'absent', reason: 'provider_failed', end: 'failed', ...proof };
      case 'budget_exhausted':
        return { kind: 'absent', reason: 'budget_exhausted', end: 'cancelled', ...proof };
      case 'quota_unavailable':
        return { kind: 'absent', reason: 'quota_unavailable', end: 'cancelled', ...proof };
      case 'unknown':
        // May have reached the provider: it stays open for reconciliation and is never resent.
        return { kind: 'absent', reason: 'unknown_outcome', ...proof };
      case 'refused':
        return { kind: 'absent', reason: `refused_${outcome.reason}`, ...proof };
    }
  };
}

/** Wraps accepted entries with the versions and lifetime they were produced under. */
export function storedAssessments(input: {
  readonly entries: readonly (EncounterRef & JevCriteria)[];
  readonly model: string;
  readonly assessedAt: Date;
  readonly lifetimeMs: number;
}): SemanticAssessments {
  return {
    roleVersion: JEV_ASSESSMENT_VERSION,
    model: input.model,
    assessedAt: input.assessedAt.toISOString(),
    expiresAt: new Date(input.assessedAt.getTime() + input.lifetimeMs).toISOString(),
    entries: input.entries,
  };
}
