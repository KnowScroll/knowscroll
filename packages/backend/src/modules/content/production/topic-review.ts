import type { Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { appendRelease, readCatalogueIn } from '../adapters/catalogue-store.js';
import { showServableTopics } from '../adapters/catalogue-sync.js';
import {
  decideTopicApproval,
  listCandidates,
  type Approval,
  type CandidateListing,
  type CandidateStatus,
} from '../adapters/topic-candidates.js';

/**
 * The owner approves each new topic (#674, D-422). A topic that grew stays not servable until an operator has read its label, its meaning and its
 * facets and approved them, in addition to the supply every new topic waits for (D-419); one the operator rejects is retired. Everything here is
 * shared, nonpersonal and local to the database: no model, no network, no personal root.
 */

/** The text of a topic that grew, as the catalogue holds it: what an operator reads before deciding. Model-written; the one place text is shown. */
export interface GrownTopicText {
  readonly label: string;
  readonly meaning: string;
  readonly servable: boolean;
  readonly facets: readonly { readonly label: string; readonly meaning: string }[];
}

export type ReviewedCandidate = CandidateListing & { readonly topic?: GrownTopicText };

/**
 * The candidates for `content topic-candidates`: each with its codes and counts and, for one that made a topic, the topic's label, meaning and
 * facets (label and meaning of each) and whether it is servable, so the operator reads what the model wrote before approving it. A page's own text
 * and title are never shown.
 */
export async function reviewCandidates(
  db: Kysely<Database>,
  options: { readonly status?: CandidateStatus },
): Promise<readonly ReviewedCandidate[]> {
  const listed = await listCandidates(db, options);
  if (!listed.some((row) => row.topicId !== null)) return listed;
  const catalogue = await readCatalogueIn(db);
  return listed.map((row) => {
    const topic = row.topicId === null ? undefined : catalogue.concept(row.topicId);
    return topic === undefined
      ? row
      : {
          ...row,
          topic: {
            label: topic.label,
            meaning: topic.meaning,
            servable: topic.servable,
            facets: topic.facets.map((facet) => ({ label: facet.label, meaning: facet.meaning })),
          },
        };
  });
}

export type TopicDecisionResult =
  /** No candidate made this topic (it is a topic of the plan, or there is none): nothing to decide. */
  | { readonly kind: 'not_grown' }
  /** A decision was made already and is never taken back. */
  | { readonly kind: 'already_decided'; readonly approval: Exclude<Approval, 'pending'> }
  /** Approved. `servable` says whether the topic is servable now (it had its supply already); otherwise it is, once the library has released it. */
  | { readonly kind: 'approved'; readonly servable: boolean }
  /** Rejected and retired by a release (`retired`): it leaves every listing, its id is never reused. */
  | { readonly kind: 'rejected'; readonly retired: boolean };

/**
 * Records the owner's decision on a topic that grew and acts on it. Approval records who and when, then makes servable any topic that has its supply
 * (`showServableTopics`, which never shows an unapproved one); it moves nothing else. A rejection records the decision and retires the topic and its
 * facets by a release (`operator` source) through the catalogue's own admission. A decision is made once.
 */
export async function decideTopic(
  db: Kysely<Database>,
  request: { readonly topicId: string; readonly decision: 'approve' | 'reject'; readonly decidedBy: string },
): Promise<TopicDecisionResult> {
  const recorded = await decideTopicApproval(
    db,
    request.topicId,
    request.decision === 'approve' ? 'approved' : 'rejected',
    request.decidedBy,
  );
  if (recorded.kind !== 'decided') return recorded;
  if (request.decision === 'approve') {
    await showServableTopics(db);
    return { kind: 'approved', servable: (await readCatalogueIn(db)).concept(request.topicId)?.servable === true };
  }
  const released = await appendRelease(db, [{ kind: 'retire', nodeId: request.topicId }], 'operator');
  return { kind: 'rejected', retired: released.kind === 'appended' };
}
