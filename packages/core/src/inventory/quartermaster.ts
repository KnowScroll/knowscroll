/**
 * #164 — the Quartermaster (`quartermaster-v1`, ADR-0046 §2). Pure: one demand's facts in, one
 * decision out. It runs when a demand is written, when supply changes and in the correction
 * catch-up; the caller loads the facts under the universe and inventory locks and applies exactly
 * this decision.
 *
 * In order: **reuse** a Scroll this reader was never shown in the concept's subtree (newest first);
 * **join** the open shared request for the concept; **fund** a new request from the first unwritten
 * material that names a concept in the subtree; otherwise **cannot meet**, with the reason that
 * stops it. A route with no budget left never makes a silent wait. **Adapt** has no v1 path (no
 * Scroll derivation, no Reel generation: #9) and every decision records that.
 */
import type { CannotMeetReason } from '../../../contracts/src/inventory.ts';
import { isWithin } from '../semantic/bridge-validator.ts';

export const QUARTERMASTER_V1 = 'quartermaster-v1';

/** Bench value (ADR-0046 §2): a demand whose requests were refused this often stops asking. */
export const QUARTERMASTER_LIMITS = Object.freeze({ refusedRequests: 2 });

export interface DemandFacts {
  /** The concept the demand needs more about. */
  concept: string;
  /** Every concept's parent (null for a root): a subtree is a concept and everything narrower. */
  parents: ReadonlyMap<string, string | null>;
  /** Eligible Scrolls with their primary concept, newest first, and whether this reader was ever shown each. */
  scrolls: readonly { assetId: string; primary: string; shown: boolean }[];
  /** The open shared request for exactly this concept, if any. */
  openRequestId: string | null;
  /** The enabled writing route and how many requests its bucket still admits; null when none is enabled. */
  route: { id: string; requestsLeft: number } | null;
  /** Installed material in install order, and whether a request for this concept was already made from it. */
  candidates: readonly { id: string; conceptCodes: readonly string[]; requested: boolean }[];
  /** How this demand's earlier requests settled, oldest first. */
  settled: readonly ('fulfilled' | 'refused' | 'failed' | 'cancelled')[];
}

export type QuartermasterDecision = { version: typeof QUARTERMASTER_V1; adapt: 'unavailable' } & (
  | { decision: 'reuse'; assetId: string }
  | { decision: 'join'; requestId: string }
  | { decision: 'fund'; candidateId: string; offeredCodes: string[] }
  | { decision: 'cannot_meet'; reason: CannotMeetReason });

/** A predicate for `root`'s subtree: the concept itself and everything narrower, by the concepts' parents. */
export function withinConcept(parents: ReadonlyMap<string, string | null>, root: string): (code: string) => boolean {
  const tree = { concepts: new Map([...parents].map(([code, parentCode]) => [code, { code, name: '', description: '', parentCode }])) };
  return code => isWithin(tree, code, root);
}

export function decideDemand(facts: DemandFacts): QuartermasterDecision {
  const within = withinConcept(facts.parents, facts.concept);
  const decided = { version: QUARTERMASTER_V1, adapt: 'unavailable' } as const;

  const unseen = facts.scrolls.find(s => !s.shown && within(s.primary));
  if (unseen) return { ...decided, decision: 'reuse', assetId: unseen.assetId };
  if (facts.openRequestId !== null) return { ...decided, decision: 'join', requestId: facts.openRequestId };

  const cannot = (reason: CannotMeetReason) => ({ ...decided, decision: 'cannot_meet' as const, reason });
  if (facts.route === null) return cannot('no_route');
  if (facts.route.requestsLeft <= 0) return cannot('no_budget');
  // A lost or failed send may still have reached the provider: it is never followed by another.
  if (facts.settled.includes('failed')) return cannot('request_failed');
  if (facts.settled.filter(s => s === 'refused').length >= QUARTERMASTER_LIMITS.refusedRequests) return cannot('checks_failed');
  // Only the concepts inside the subtree are offered, so the checks themselves keep the Scroll's
  // primary concept there (`concept_not_offered`).
  const material = facts.candidates.find(c => !c.requested && c.conceptCodes.some(within));
  if (!material) return cannot('no_material');
  return { ...decided, decision: 'fund', candidateId: material.id, offeredCodes: material.conceptCodes.filter(within) };
}
