import { sql, type Kysely } from 'kysely';
import { stableUuid } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { productionTransactionOf } from '../../../infrastructure/postgres/index.js';
import type {
  ContextItem,
  ProductionAuthority,
  ProductionReasoningHarness,
  ProposeOutcome,
  WithProductionScope,
} from '../../../reasoning/public.js';
import { appendReleaseIn, readCatalogueIn } from '../adapters/catalogue-store.js';
import {
  beginAttempt,
  blockCandidate,
  countFailedAttempt,
  openTopicProposal,
  readCandidate,
  readTopicProposal,
  settleAdmitted,
  settleRefused,
  settleRejected,
  settleTopicProposal,
  type Candidate,
} from '../adapters/topic-candidates.js';
import type { CatalogueSnapshot } from '../domain/catalogue/snapshot.js';
import {
  admitTopicProposal,
  duplicatesTopic,
  leadPassages,
  offeredSystems,
  type TopicProposalOutput,
} from '../domain/catalogue/topic-growth.js';
import { pauseCode, uncheckedCode } from './answer-check-step.js';
import { settlementOf } from './propose-recipes.js';
import {
  TOPIC_PROPOSAL_REQUEST_BOUND,
  TOPIC_PROPOSAL_ROLE_VERSION,
  topicProposalContext,
  topicProposalRequestKey,
  topicProposalRole,
  type ExampleTopic,
} from './topic-proposal.js';

export interface ProposeTopicDependencies {
  readonly db: Kysely<Database>;
  readonly authority: ProductionAuthority;
  readonly withScope: WithProductionScope;
  readonly harness: ProductionReasoningHarness;
  /** `KS_TOPIC_GROWTH_MAX_PER_SYSTEM`: the most topics (servable or not) a system may hold. */
  readonly maxTopicsPerSystem: number;
  /** The clock: the UTC day an attempt begins on is part of what makes a request the same request. Defaults to the system clock. */
  readonly now?: () => Date;
}

/** What is asked: one candidate page, which code found, by its address. */
export interface ProposeTopicRequest {
  readonly pageUrl: string;
  readonly dryRun: boolean;
}

export type ProposeTopicResult =
  /**
   * Nothing was sent and nothing was paid: the page is no candidate, it is not open to a proposal (its status says why), no system has
   * room under the size limit, or it has become an existing topic's duplicate since it was read.
   */
  | {
      readonly kind: 'refused';
      readonly reason: 'not_a_candidate' | 'not_open' | 'no_system_with_room' | 'duplicate_topic';
      readonly status?: string;
    }
  /** The context a run would send, in counts. Nothing was sent and nothing was stored. */
  | {
      readonly kind: 'dry_run';
      readonly contextItems: number;
      readonly passages: number;
      readonly systemsOffered: number;
      readonly requestBound: number;
    }
  /** An earlier delivery of this very request already ended: nothing was paid again. */
  | { readonly kind: 'already_decided'; readonly runId: string; readonly outcome: string; readonly topicId?: string }
  /** A topic was admitted: a release of the catalogue, not servable until the library has released supply for it. */
  | {
      readonly kind: 'admitted';
      readonly runId: string;
      readonly topicId: string;
      readonly facets: number;
      readonly releaseId: number;
      readonly repaired: boolean;
      readonly requestBound: number;
    }
  /** The model found no fit (`declined`), or its answer was not admitted by code (`code`). The candidate is refused. */
  | {
      readonly kind: 'not_admitted';
      readonly runId: string;
      readonly code: string;
      readonly repaired: boolean;
      readonly requestBound: number;
    }
  /** A daily budget or the provider's quota is used up: nothing was sent and the run stays open for a later send. */
  | { readonly kind: 'paused'; readonly runId: string; readonly code: string }
  /**
   * The model gave no usable answer, or the answer could not be applied. `closed` says whether the run ended: a conclusive failure ends it
   * and counts as a failed attempt. An attempt of unknown outcome, a refusal of the harness and a scope that refused leave it open, and
   * nothing is ever resent.
   */
  | {
      readonly kind: 'failed';
      readonly runId: string;
      readonly code: string;
      readonly unknown: boolean;
      readonly closed: boolean;
    };

/** The refusals of the harness that mean nothing was sent: the others (a lost dispatch, a changed request, a written-off attempt) may have reached the provider. */
const NOTHING_SENT: ReadonlySet<string> = new Set([
  'provider_unavailable',
  'role_invalid',
  'run_invalid',
  'context_invalid',
  'context_insufficient',
  'request_too_large',
  'scope_refused',
]);

/** The UTC day of a moment, `2026-11-12`. */
export const utcDayOf = (now: Date): string => now.toISOString().slice(0, 10);

const exampleOf = (snapshot: CatalogueSnapshot, systemId: string | undefined): ExampleTopic | undefined => {
  const topic = snapshot.allTopics().find((candidate) => candidate.parent === systemId && candidate.facets.length > 0);
  return topic === undefined
    ? undefined
    : {
        label: topic.label,
        meaning: topic.meaning,
        facets: topic.facets.map((facet) => ({ label: facet.label, meaning: facet.meaning })),
      };
};

/** What a candidate would send: the context and the systems offered; or why nothing can be proposed. */
async function prepare(db: Kysely<Database>, maxTopicsPerSystem: number, candidate: Candidate) {
  const catalogue = await readCatalogueIn(db);
  const passages = leadPassages(candidate.passages ?? []);
  const title = candidate.title ?? candidate.pageUrl;
  if (
    duplicatesTopic(
      title,
      catalogue.allTopics().map((topic) => topic.label),
    )
  )
    return { kind: 'duplicate_topic' } as const;
  const systems = offeredSystems(catalogue, `${title} ${passages.join(' ')}`, maxTopicsPerSystem);
  if (systems.length === 0) return { kind: 'no_system_with_room' } as const;
  const example = exampleOf(catalogue, systems[0]?.id);
  return {
    kind: 'ready',
    items: topicProposalContext({ pageTitle: title, passages, systems, ...(example === undefined ? {} : { example }) }),
    shortlist: systems.map((system) => system.id),
  } as const;
}

/** The run a request is: derived from the candidate page, the day the attempt began on and which attempt it is. */
const runIdOf = (pageUrl: string, day: string, retry: number): string =>
  stableUuid(`content.topic-proposal:${topicProposalRequestKey({ pageUrl, day, retry })}`);

/**
 * What a proposal would send, in counts, without calling a provider or storing anything: the operator's `--dry-run`. Reads the shared
 * database only, so it needs no model and no production grant.
 */
export async function previewTopicProposal(
  db: Kysely<Database>,
  request: Pick<ProposeTopicRequest, 'pageUrl'>,
  maxTopicsPerSystem: number,
): Promise<Extract<ProposeTopicResult, { kind: 'refused' | 'dry_run' }>> {
  const candidate = await readCandidate(db, request.pageUrl);
  if (candidate === undefined) return { kind: 'refused', reason: 'not_a_candidate' };
  if ((candidate.status !== 'eligible' && candidate.status !== 'proposed') || candidate.passages === undefined)
    return { kind: 'refused', reason: 'not_open', status: candidate.status };
  const prepared = await prepare(db, maxTopicsPerSystem, candidate);
  if (prepared.kind !== 'ready') return { kind: 'refused', reason: prepared.kind };
  return {
    kind: 'dry_run',
    contextItems: prepared.items.length,
    passages: candidate.passages.length,
    systemsOffered: prepared.shortlist.length,
    requestBound: TOPIC_PROPOSAL_REQUEST_BOUND,
  };
}

/**
 * Proposes a topic for a candidate page (#674, D-422): the model places it and names its facets, code decides.
 *
 * One request of the proposal role, and at most one repair, on the production harness and its attempt ledger, so every paid attempt is
 * recorded and counted against the production caps and the role's background share. The run id is derived from the request (the candidate
 * page, the UTC day the attempt began on and which attempt it is), never from what the request goes on to store, and the first delivery
 * freezes the context and the systems it offers in `content.topic_proposals`: a later delivery sends that same context, so the harness
 * answers from its ledger even when the catalogue has changed since, and a paid answer that was kept is never refused as a changed request.
 * An attempt of unknown outcome is never resent and its candidate is blocked. A conclusive failure is counted and the candidate may be asked
 * about again on another day, once.
 *
 * No network wait or model call holds a transaction. After the answer, one short production transaction takes the catalogue's release
 * lock, reads the catalogue as it is now, checks the proposal against it (`admitTopicProposal`), makes the release through the catalogue's
 * own admission, settles the candidate and the proposing run and closes the harness run. A topic is admitted not servable: nothing is
 * offered, matched or listed until the library has released supply for it. Nothing here makes a system, and nothing here sends a
 * production job.
 */
export function makeProposeTopic(deps: ProposeTopicDependencies) {
  const now = deps.now ?? (() => new Date());

  /** A run that has ended: what it decided. */
  async function endedRun(runId: string): Promise<ProposeTopicResult> {
    const run = await readTopicProposal(deps.db, runId);
    return {
      kind: 'already_decided',
      runId,
      outcome: run?.outcome ?? 'closed',
      ...(run?.topicId === undefined ? {} : { topicId: run.topicId }),
    };
  }

  /** Checks the answer against the catalogue as it is now and admits it, with the candidate and the run settled, in one transaction. */
  async function storeAnswer(
    runId: string,
    candidate: Candidate,
    shortlist: readonly string[],
    outcome: Extract<ProposeOutcome<TopicProposalOutput>, { kind: 'proposed' }>,
  ): Promise<ProposeTopicResult> {
    const stored = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      // The release lock first: everything below judges the catalogue as it stands, and nothing can release under it.
      await sql`select pg_advisory_xact_lock(hashtextextended('content.concept-releases', 0))`.execute(tx);
      // Another delivery (the scheduled pass and the operator's command may meet on one candidate) may have decided this run while the answer
      // was kept: what it decided stands, and nothing is released twice.
      const settled = await readTopicProposal(tx, runId);
      if (settled !== undefined && settled.state !== 'open')
        return { kind: 'decided_elsewhere', outcome: settled.outcome ?? 'closed', topicId: settled.topicId } as const;
      const verdict = admitTopicProposal(outcome.output, {
        snapshot: await readCatalogueIn(tx),
        offered: shortlist,
        maxTopicsPerSystem: deps.maxTopicsPerSystem,
        passages: candidate.passages ?? [],
      });
      let decided:
        | { readonly kind: 'admitted'; readonly topicId: string; readonly facets: number; readonly releaseId: number }
        | { readonly kind: 'not_admitted'; readonly code: string };
      if (verdict.kind === 'admitted') {
        const release = await appendReleaseIn(tx, verdict.changes, 'growth');
        decided =
          release.kind === 'appended'
            ? {
                kind: 'admitted',
                topicId: verdict.topicId,
                facets: verdict.facetIds.length,
                releaseId: release.releaseId,
              }
            : {
                kind: 'not_admitted',
                code:
                  release.kind === 'refused'
                    ? `catalogue_${release.refusals[0]?.code ?? 'refused'}`
                    : 'catalogue_unchanged',
              };
      } else decided = { kind: 'not_admitted', code: verdict.kind === 'declined' ? 'declined' : verdict.code };
      if (decided.kind === 'admitted') {
        await settleAdmitted(tx, candidate.pageUrl, decided.topicId);
        await settleTopicProposal(tx, runId, 'completed', 'admitted', decided.topicId);
      } else {
        await settleRefused(tx, candidate.pageUrl, decided.code);
        await settleTopicProposal(tx, runId, 'completed', decided.code);
      }
      await deps.harness.closeProductionRun(scope, { runId, state: 'completed' });
      return decided;
    });
    // A scope that was switched off or changed stores nothing and closes nothing: the run stays open for a later delivery.
    if (stored.kind !== 'entered')
      return { kind: 'failed', runId, code: 'scope_refused', unknown: false, closed: false };
    const decided = stored.value;
    if (decided.kind === 'decided_elsewhere')
      return {
        kind: 'already_decided',
        runId,
        outcome: decided.outcome,
        ...(decided.topicId === undefined ? {} : { topicId: decided.topicId }),
      };
    return decided.kind === 'admitted'
      ? {
          kind: 'admitted',
          runId,
          topicId: decided.topicId,
          facets: decided.facets,
          releaseId: decided.releaseId,
          repaired: outcome.repaired,
          requestBound: TOPIC_PROPOSAL_REQUEST_BOUND,
        }
      : {
          kind: 'not_admitted',
          runId,
          code: decided.code,
          repaired: outcome.repaired,
          requestBound: TOPIC_PROPOSAL_REQUEST_BOUND,
        };
  }

  /** Ends a run after a conclusive failure: the proposing run and the harness run close as failed, and the attempt is counted, together. */
  async function closeFailed(runId: string, pageUrl: string): Promise<boolean> {
    const closed = await deps.withScope(deps.authority, async (scope) => {
      const tx = productionTransactionOf(scope);
      await settleTopicProposal(tx, runId, 'failed', 'model_failed');
      await countFailedAttempt(tx, pageUrl);
      await deps.harness.closeProductionRun(scope, { runId, state: 'failed' });
    });
    return closed.kind === 'entered';
  }

  return async function proposeTopic(request: ProposeTopicRequest, signal: AbortSignal): Promise<ProposeTopicResult> {
    if (request.dryRun) return previewTopicProposal(deps.db, request, deps.maxTopicsPerSystem);
    const candidate = await readCandidate(deps.db, request.pageUrl);
    if (candidate === undefined) return { kind: 'refused', reason: 'not_a_candidate' };
    if ((candidate.status !== 'eligible' && candidate.status !== 'proposed') || candidate.passages === undefined)
      return { kind: 'refused', reason: 'not_open', status: candidate.status };
    // The attempt's day is pinned on the candidate: a delivery after midnight is the same request and is answered by the ledger.
    const begun = await beginAttempt(deps.db, candidate.pageUrl, utcDayOf(now()));
    if (begun === undefined) return { kind: 'refused', reason: 'not_open', status: candidate.status };
    const runId = runIdOf(candidate.pageUrl, begun.day, begun.retry);
    // The first delivery freezes its context; every later one sends that very context, whatever the catalogue holds by then. A run
    // already in flight is resumed as it is, so a room that filled in the meantime does not strand a paid answer.
    let proposal = await readTopicProposal(deps.db, runId);
    if (proposal === undefined) {
      const prepared = await prepare(deps.db, deps.maxTopicsPerSystem, candidate);
      if (prepared.kind !== 'ready') {
        // Free refusals. A page that is an existing topic again is rejected for good; a catalogue with no room is only waited on.
        if (prepared.kind === 'duplicate_topic') await settleRejected(deps.db, candidate.pageUrl, 'duplicate_topic');
        else await releaseAttempt(deps.db, candidate.pageUrl);
        return { kind: 'refused', reason: prepared.kind };
      }
      proposal = await openTopicProposal(deps.db, {
        runId,
        pageUrl: candidate.pageUrl,
        day: begun.day,
        retry: begun.retry,
        shortlist: prepared.shortlist,
        items: prepared.items,
      });
    }
    if (proposal.state !== 'open') return endedRun(runId);
    const items: readonly ContextItem[] | undefined = proposal.items;
    if (items === undefined)
      return { kind: 'failed', runId, code: 'frozen_context_unreadable', unknown: false, closed: false };

    const outcome = await deps.harness.proposeProduction(
      {
        run: {
          id: runId,
          authority: deps.authority,
          ownerModule: 'content',
          purpose: 'topic-proposal',
          policyVersion: TOPIC_PROPOSAL_ROLE_VERSION,
        },
        role: topicProposalRole(),
        context: { bundleRef: `topic:${runId.slice(0, 8)}`, items },
      },
      signal,
    );
    // Another delivery closed the run while this one waited: read how it ended.
    if (outcome.kind === 'refused' && outcome.reason === 'run_closed') return endedRun(runId);
    if (outcome.kind === 'budget_exhausted' || outcome.kind === 'quota_unavailable')
      return { kind: 'paused', runId, code: pauseCode(outcome) };
    if (outcome.kind === 'proposed') return storeAnswer(runId, candidate, proposal.shortlist, outcome);
    const code = uncheckedCode(outcome);
    // A refusal that sent nothing (no provider configured, the production scope off, a request the harness cannot take) costs nothing and
    // changes nothing: the run stays open and the same request is sent again when the cause is gone.
    if (outcome.kind === 'refused' && NOTHING_SENT.has(outcome.reason)) return { kind: 'paused', runId, code };
    if (settlementOf(outcome) === 'open') {
      // May have reached the provider: never resent, and the candidate is not offered again until an operator has looked.
      await blockCandidate(deps.db, candidate.pageUrl, outcome.kind === 'unknown' ? 'outcome_unknown' : code);
      return { kind: 'failed', runId, code, unknown: outcome.kind === 'unknown', closed: false };
    }
    const closed = await closeFailed(runId, candidate.pageUrl);
    return { kind: 'failed', runId, code: closed ? code : 'scope_refused', unknown: false, closed };
  };
}

/** Takes the pin off an attempt that sent nothing, so the candidate is as it was before it was chosen. */
async function releaseAttempt(db: Kysely<Database>, pageUrl: string): Promise<void> {
  await sql`update content.topic_candidates set status = 'eligible', attempt_day = null, updated_at = now()
    where page_url = ${pageUrl} and status = 'proposed'`.execute(db);
}
