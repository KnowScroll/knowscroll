import { sql, type Kysely } from 'kysely';
import { AuthoredScroll } from '@knowscroll/scroll-model/producer';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';
import type {
  ProductionAuthority,
  ProductionReasoningHarness,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { noClaimGround, type SentenceUnderCheck, type SentenceVerdict } from '../domain/ask-support.js';
import { candidateCheckerRole, type CandidateCheckerInstructions } from './ask-support-candidate.js';
import { makeAskSupportStep } from './ask-support-step.js';
import { askSupportRole, sentencesOfAnswer } from './ask-support.js';
import { evidencePassages, type EvidencePassage } from './evidence.js';
import { SPIKE_MODEL } from './spike-v2/run.js';

/** The policy version of a replay's runs in the production ledger. */
export const ASK_SUPPORT_REPLAY_POLICY_VERSION = 'ask-support-replay.v1';

/** The most answers one replay reads. A replay is paid for, one call each. */
export const ASK_SUPPORT_REPLAY_MAX = 20;

/** Which stored ask answers to replay: named by asset, or the newest published ones. */
export type ReplayTarget =
  | { readonly kind: 'assets'; readonly assetIds: readonly string[] }
  | { readonly kind: 'recent'; readonly count: number };

export type ReplayOutcome =
  /** The checker answered. */
  | 'checked'
  /** The checker gave nothing usable (`code` says why); no verdict. */
  | 'unchecked'
  /** A daily budget or the provider's quota is used up: nothing was sent. */
  | 'paused'
  /** No published ask answer has this asset, or its stored answer or research cannot be read. */
  | 'not_replayable'
  | 'model_mismatch';

/** What the operator prints for one answer: counts and codes, never a sentence, a title or a question. */
export interface ReplayLine {
  readonly assetId: string;
  readonly outcome: ReplayOutcome;
  readonly sentences: number;
  readonly supported: number;
  readonly unsupported: number;
  readonly noClaim: number;
  /** How many requests' worth of sentences the answer was split into (D-267). */
  readonly batches: number;
  /** Paid requests the replay sent: one for each batch, and one more when the harness repaired an unusable reply. */
  readonly requests: number;
  /**
   * For each rule code, how many sentences code set aside as unsupported (D-265), and for each ground, how many sentences passed as
   * `no_claim` on it (`no_claim_label`, `no_claim_gap`, `no_claim_question`, `no_claim_unshared`, D-266), so a replay shows how many
   * pass on a label's word and how many on a gap line. The sentences' words are never here.
   */
  readonly codes: Readonly<Record<string, number>>;
  /** Why the check gave no usable answer, when it did not. */
  readonly code?: string;
  readonly runIds?: readonly string[];
  /** Present, and `true`, when the replay used candidate instructions rather than the production ones (D-280). */
  readonly candidate?: true;
  /** The SHA-256 of the candidate file, on every line of a candidate replay. */
  readonly candidateSha256?: string;
}

/** One sentence as the file shows it: the sentence, the passages it cites and the checker's verdict on it. */
export interface ReplaySentence extends SentenceUnderCheck {
  readonly verdict: SentenceVerdict['verdict'];
  readonly kind?: string;
  readonly problem?: string;
  /** The rule code, when code set the sentence aside as unsupported (D-265). */
  readonly code?: string;
  readonly quote?: string;
}

/** The detail written to the operator's file for a checked answer. It holds the answer's own words and never the question. */
export interface ReplayDetail {
  readonly assetId: string;
  readonly title: string;
  readonly runIds: readonly string[];
  readonly sentences: readonly ReplaySentence[];
  readonly candidate?: true;
  readonly candidateSha256?: string;
}

export interface ReplayResult {
  readonly line: ReplayLine;
  readonly detail?: ReplayDetail;
}

export interface AskSupportReplayDeps {
  readonly db: Kysely<Database>;
  readonly harness: ProductionReasoningHarness;
  readonly withScope: WithProductionScope;
  readonly authority: ProductionAuthority;
  /** The model the harness is configured with; the replay refuses to run on any other (D-031). */
  readonly model: string;
  readonly newRunKey: () => string;
  /**
   * Candidate checker instructions to try in place of the production ones (D-280). Every line and detail the replay
   * produces is then labelled with the candidate's hash. Only the operator's `ask-check` passes it.
   */
  readonly candidate?: CandidateCheckerInstructions;
}

interface StoredAnswer {
  readonly asset_id: string;
  readonly research: readonly ResearchPage[];
  readonly writer_output: unknown;
}

const emptyLine = (assetId: string, outcome: ReplayOutcome, code?: string): ReplayLine => ({
  assetId,
  outcome,
  sentences: 0,
  supported: 0,
  unsupported: 0,
  noClaim: 0,
  batches: 0,
  requests: 0,
  codes: {},
  ...(code === undefined ? {} : { code }),
});

/** How many sentences each rule code set aside, and how many `no_claim` verdicts passed on each ground. */
function codeCounts(
  verdicts: readonly SentenceVerdict[],
  sentences: readonly SentenceUnderCheck[],
  passages: readonly EvidencePassage[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const textOf = new Map(passages.map((passage) => [passage.handle, passage.text]));
  const sentenceOf = new Map(sentences.map((sentence) => [sentence.number, sentence]));
  for (const verdict of verdicts) {
    if (verdict.verdict === 'unsupported' && verdict.code !== undefined) count(verdict.code);
    const sentence = sentenceOf.get(verdict.number);
    if (verdict.verdict !== 'no_claim' || sentence === undefined) continue;
    const cited = sentence.cites.flatMap((handle) => textOf.get(handle) ?? []);
    count(`no_claim_${noClaimGround(sentence, cited) ?? 'unknown'}`);
  }
  return counts;
}

/** Whether an asset id is a UUID, so it can be matched without a cast failing the whole read. */
export const isAssetId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

/** The stored answers a target names: published ask orders only, with the research they cited and the answer the writer authored. */
async function storedAnswers(db: Kysely<Database>, target: ReplayTarget): Promise<readonly StoredAnswer[]> {
  const named = target.kind === 'assets' ? sql`and run.asset_id = any(${target.assetIds}::uuid[])` : sql``;
  const limit = target.kind === 'assets' ? ASK_SUPPORT_REPLAY_MAX : target.count;
  const result = await sql<StoredAnswer>`select run.asset_id, run.research, run.writer_output
    from content.scroll_production_runs run
    join content.made_to_order_scrolls ordered on ordered.recipe = run.topic and ordered.mode = 'question'
    where run.state = 'published' and run.asset_id is not null ${named}
    order by run.completed_at desc limit ${limit}`.execute(db);
  return result.rows;
}

/**
 * Replays the support check (D-250) over stored ask answers, for an operator who wants to see what the checker says about
 * answers a person was already served. For each answer it rebuilds the passages from the research the job froze, reads the
 * authored answer the job kept, and asks the same checker role the live path asks, in a run of its own through the
 * production harness (so the call has an attempt in the ledger and counts against the production caps). Nothing is
 * stored, published or changed: the answer's Scroll, the job and the person's request are untouched, and the question is
 * never read, because the check does not use it.
 *
 * No model call or network wait runs inside a transaction. A spent budget or quota stops the replay at that answer.
 */
export function makeAskSupportReplay(deps: AskSupportReplayDeps) {
  const { candidate } = deps;
  const step = makeAskSupportStep(
    deps,
    candidate === undefined
      ? askSupportRole
      : (sentences, passages) => candidateCheckerRole(candidate, sentences, passages),
  );
  /** A candidate replay marks everything it produces, so its output can never be read as the production checker's. */
  const labelled = (result: ReplayResult): ReplayResult => {
    if (candidate === undefined) return result;
    const label = { candidate: true as const, candidateSha256: candidate.sha256 };
    return {
      line: { ...result.line, ...label },
      ...(result.detail === undefined ? {} : { detail: { ...result.detail, ...label } }),
    };
  };

  async function replayOne(stored: StoredAnswer, signal: AbortSignal): Promise<ReplayResult> {
    const assetId = stored.asset_id;
    const answer = AuthoredScroll.safeParse(stored.writer_output);
    let passages: readonly EvidencePassage[];
    try {
      passages = evidencePassages(stored.research);
    } catch {
      return { line: emptyLine(assetId, 'not_replayable', 'evidence_unavailable') };
    }
    if (!answer.success) return { line: emptyLine(assetId, 'not_replayable', 'answer_unreadable') };
    const sentences = sentencesOfAnswer(answer.data);
    const jobId = `replay:${deps.newRunKey()}`;
    const checked = await step.check({
      jobId,
      policyVersion: ASK_SUPPORT_REPLAY_POLICY_VERSION,
      draft: 1,
      sentences,
      passages,
      signal,
    });
    if (checked.kind === 'paused') return { line: emptyLine(assetId, 'paused', checked.code) };
    // A fresh run id cannot already be closed.
    if (checked.kind === 'advanced') return { line: emptyLine(assetId, 'not_replayable', 'run_closed') };
    const runIds = checked.runs.map((run) => run.runId);
    // An attempt of unknown outcome keeps its run open for reconciliation; every other run is final.
    const unknown = checked.record.code === 'outcome_unknown';
    for (const run of unknown ? checked.runs.slice(0, -1) : checked.runs)
      await deps.withScope(deps.authority, (scope) =>
        deps.harness.closeProductionRun(scope, { runId: run.runId, state: run.state }),
      );
    const verdicts = new Map(checked.verdicts.map((verdict) => [verdict.number, verdict]));
    const count = (kind: SentenceVerdict['verdict']) =>
      checked.verdicts.filter((verdict) => verdict.verdict === kind).length;
    const line: ReplayLine = {
      assetId,
      outcome: checked.record.kind,
      sentences: sentences.length,
      supported: count('supported'),
      unsupported: count('unsupported'),
      noClaim: count('no_claim'),
      batches: checked.record.batches,
      requests: checked.receipt.attempts?.length ?? 0,
      codes: codeCounts(checked.verdicts, sentences, passages),
      runIds,
      ...(checked.record.code === undefined ? {} : { code: checked.record.code }),
    };
    if (checked.record.kind !== 'checked') return { line };
    const detail: ReplayDetail = {
      assetId,
      title: answer.data.title,
      runIds,
      sentences: sentences.map((sentence): ReplaySentence => {
        const verdict = verdicts.get(sentence.number);
        return {
          ...sentence,
          verdict: verdict?.verdict ?? 'no_claim',
          ...(verdict?.verdict === 'unsupported'
            ? {
                kind: verdict.kind,
                problem: verdict.problem,
                ...(verdict.code === undefined ? {} : { code: verdict.code }),
              }
            : {}),
          ...(verdict?.verdict === 'supported' ? { quote: verdict.quote } : {}),
        };
      }),
    };
    return { line, detail };
  }

  /** Replays each named answer in turn, handing every result to `emit` as it finishes. Stops at a spent budget or quota. */
  return async function replay(
    target: ReplayTarget,
    signal: AbortSignal,
    emit: (result: ReplayResult) => Promise<void> | void,
  ): Promise<{ readonly answers: number; readonly stopped: boolean }> {
    if (deps.model !== SPIKE_MODEL) {
      await emit(labelled({ line: emptyLine('', 'model_mismatch', 'configured_model_not_allowed') }));
      return { answers: 0, stopped: true };
    }
    const stored = await storedAnswers(deps.db, target);
    const found = new Set(stored.map((answer) => answer.asset_id.toLowerCase()));
    if (target.kind === 'assets')
      for (const assetId of target.assetIds)
        if (!found.has(assetId.toLowerCase()))
          await emit(labelled({ line: emptyLine(assetId, 'not_replayable', 'not_an_ask_answer') }));
    let answers = 0;
    for (const answer of stored) {
      if (signal.aborted) return { answers, stopped: true };
      const result = labelled(await replayOne(answer, signal));
      await emit(result);
      answers += 1;
      if (
        result.line.outcome === 'paused' ||
        (result.line.outcome === 'unchecked' && result.line.code === 'outcome_unknown')
      )
        return { answers, stopped: true };
    }
    return { answers, stopped: false };
  };
}
