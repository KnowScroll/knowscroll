import { z } from 'zod';
import {
  HARNESS_PROMPT_VERSION,
  type ReasoningContext,
  type ReasoningHarness,
  type ReasoningRole,
} from '../../../reasoning/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import type { PersonalAuthority } from '../../identity/public.js';
import { JEV_SHORTLIST_LIMIT } from '../domain/jev.js';
import { refKey } from '../domain/policy.js';
import type { EncounterRef, JevCriteria, SemanticAssessments } from '../domain/types.js';

export const JEV_ROLE_ID = 'composer.jev';
/** Changes with the instructions or the output schema. Recorded on every run and stored assessment. */
export const JEV_ROLE_VERSION = 'jev.1';
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

const ITEM_TEXT_LIMIT = 700;

function describe(encounter: EncounterSnapshot): string {
  const facets = encounter.facets.length ? `\nFacets: ${encounter.facets.join(', ')}` : '';
  return `Title: ${encounter.metadata.title}\nSummary: ${encounter.metadata.summary}${facets}`.slice(
    0,
    ITEM_TEXT_LIMIT,
  );
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

export type JevResult =
  | { readonly kind: 'assessed'; readonly entries: readonly (EncounterRef & JevCriteria)[]; readonly end: JevRunEnd }
  | { readonly kind: 'absent'; readonly reason: string; readonly end?: JevRunEnd };

export interface AssessShortlist {
  (request: {
    /** The queue job's ID: stable across deliveries, so a redelivery answers from the attempt ledger. */
    readonly runId: string;
    readonly authority: PersonalAuthority;
    readonly source: EncounterSnapshot;
    readonly shortlist: readonly EncounterSnapshot[];
    readonly signal: AbortSignal;
  }): Promise<JevResult>;
}

/**
 * Jev: a fast optional semantic assessment of a shortlist (blueprint §9). It runs only in the
 * buffer worker and never inside a database transaction. Provider failure, refusal or an unusable
 * answer is the absence of an assessment, never a negative judgement.
 */
export function makeAssessShortlist(harness: ReasoningHarness): AssessShortlist {
  return async ({ runId, authority, source, shortlist, signal }) => {
    const { context, candidatesByRef } = jevContext(source, shortlist);
    const outcome = await harness.propose(
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
    switch (outcome.kind) {
      case 'proposed':
        return { kind: 'assessed', entries: acceptAssessments(outcome.output, candidatesByRef), end: 'completed' };
      case 'invalid_output':
        return { kind: 'absent', reason: 'invalid_output', end: 'failed' };
      case 'failed':
        return { kind: 'absent', reason: 'provider_failed', end: 'failed' };
      case 'budget_exhausted':
        return { kind: 'absent', reason: 'budget_exhausted', end: 'cancelled' };
      case 'quota_unavailable':
        return { kind: 'absent', reason: 'quota_unavailable', end: 'cancelled' };
      case 'unknown':
        // May have reached the provider: it stays open for reconciliation and is never resent.
        return { kind: 'absent', reason: 'unknown_outcome' };
      case 'refused':
        return { kind: 'absent', reason: `refused_${outcome.reason}` };
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
