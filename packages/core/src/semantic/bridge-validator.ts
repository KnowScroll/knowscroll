/**
 * #131 — the deterministic bridge validator (ADR-0031). Pure: it reads only the proposal and a
 * read set the caller assembled under the universe/substrate locks, and returns a decision with a
 * closed vocabulary of reasons. No database, HTTP, provider or UI import (packages/core/AGENTS.md).
 *
 * What makes a conceptual bridge admissible (target 07 §2, 08 §3–4):
 *   1. both concepts exist, differ, and are not simply parent and child (that is depth, not a bridge);
 *   2. every cited claim resolves and is currently supported by a current source snapshot;
 *   3. each side has its own evidence;
 *   4. the mechanism is evidenced — by one claim that itself connects both sides, or, for a
 *      symmetric comparison, by one claim per side naming the same mechanism concept;
 *   5. directional types carry the direction in that evidence (an `explains` bridge needs a claim in
 *      which the explaining side is the mechanism);
 *   6. analogies state where the analogy stops;
 *   7. known counterevidence is listed, and a directional bridge the substrate contradicts is refused.
 *
 * Shared words between the two sides are reported as a diagnostic and never count as support:
 * a keyword match is exactly the "tempting but unsupported" connection this function exists to
 * refuse.
 */
import {
  BRIDGE_VALIDATOR_VERSION,
  SYMMETRIC_BRIDGE_TYPES,
  type BridgeDecision,
  type BridgeProposalPayload,
  type BridgeRejectionReason,
} from '../../../contracts/src/semantic.ts';

export type ClaimRole = 'subject' | 'object' | 'mechanism' | 'context';

export interface ReadSetConcept { code: string; name: string; description: string; parentCode: string | null }
export interface ReadSetClaim {
  key: string;
  /** `supported`: at least one `supports` quote on a current snapshot. Anything else cannot be
   * cited as evidence, whatever else it says. */
  status: 'supported' | 'unsupported';
  concepts: readonly { code: string; role: ClaimRole }[];
}
export interface ReadSetRelation { from: string; to: string; kind: string; claimKey: string; active: boolean }
export interface ReadSetBridge { id: string; fromConcept: string; toConcept: string; relationType: string }

export interface BridgeReadSet {
  concepts: ReadonlyMap<string, ReadSetConcept>;
  claims: ReadonlyMap<string, ReadSetClaim>;
  relations: readonly ReadSetRelation[];
  admittedBridges: readonly ReadSetBridge[];
}

/** Ancestors of `code` via parentCode, nearest first. Stops on an unknown parent or a cycle. */
export function ancestorsOf(readSet: Pick<BridgeReadSet, 'concepts'>, code: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([code]);
  let parent = readSet.concepts.get(code)?.parentCode ?? null;
  while (parent !== null && !seen.has(parent)) {
    out.push(parent);
    seen.add(parent);
    parent = readSet.concepts.get(parent)?.parentCode ?? null;
  }
  return out;
}

/** True when `code` is `root` or one of its descendants. */
export function isWithin(readSet: Pick<BridgeReadSet, 'concepts'>, code: string, root: string): boolean {
  return code === root || ancestorsOf(readSet, code).includes(root);
}

/** Ancestor-or-descendant: the two codes lie on one branch of the hierarchy. */
function onOneBranch(readSet: BridgeReadSet, a: string, b: string): boolean {
  return isWithin(readSet, a, b) || isWithin(readSet, b, a);
}

/** A claim supports a side when it names that concept or a broader one: what holds for gravity
 * holds for a narrower aspect of it, but a claim about star birth says nothing about stars in
 * general. Evidence never generalises upward. */
function sideLinks(readSet: BridgeReadSet, claim: ReadSetClaim, side: string) {
  return claim.concepts.filter(link => link.role !== 'context' && isWithin(readSet, side, link.code));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'its', 'are', 'was', 'what', 'how', 'why', 'not', 'one', 'can', 'more', 'than', 'their', 'they', 'which', 'when', 'about']);
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)));
}

/** Diagnostic only: the vocabulary the two sides share. Reported, never counted. */
export function sharedVocabulary(readSet: BridgeReadSet, from: string, to: string): string[] {
  const a = readSet.concepts.get(from);
  const b = readSet.concepts.get(to);
  if (!a || !b) return [];
  const left = words(`${a.name} ${a.description}`);
  return [...words(`${b.name} ${b.description}`)].filter(w => left.has(w)).sort();
}

/** A mechanism that only restates the relation or the two names is a label, not an explanation. */
function mechanismIsLabel(payload: BridgeProposalPayload, readSet: BridgeReadSet): boolean {
  const labelWords = words(`${payload.relationType.replace(/_/g, ' ')} ${readSet.concepts.get(payload.fromConcept)?.name ?? ''} ${readSet.concepts.get(payload.toConcept)?.name ?? ''}`);
  const own = [...words(payload.mechanism)].filter(w => !labelWords.has(w));
  return own.length < 5;
}

/** The serializable form of a read set, as recorded on a proposal. */
export interface ReadSetRecord {
  concepts: ReadSetConcept[];
  claims: ReadSetClaim[];
  relations: ReadSetRelation[];
  admittedBridges: ReadSetBridge[];
}

export function readSetFromRecord(record: ReadSetRecord): BridgeReadSet {
  return {
    concepts: new Map(record.concepts.map(c => [c.code, c])),
    claims: new Map(record.claims.map(c => [c.key, c])),
    relations: record.relations,
    admittedBridges: record.admittedBridges,
  };
}

/**
 * Exactly the part of the substrate a decision about `payload` consults: both sides and their
 * ancestors, every cited claim with the concepts it names (and their ancestors), the active
 * contradictions, and admitted bridges of the same type touching either side. Recorded on the
 * proposal so the decision can be re-derived later from the proposal row alone:
 * `validateBridgeProposal(p, full) === validateBridgeProposal(p, readSetFromRecord(sliceReadSet(p, full)))`.
 */
export function sliceReadSet(payload: BridgeProposalPayload, readSet: BridgeReadSet): ReadSetRecord {
  const codes = new Set<string>();
  const addWithAncestors = (code: string) => {
    if (!readSet.concepts.has(code)) return;
    codes.add(code);
    for (const a of ancestorsOf(readSet, code)) codes.add(a);
  };
  addWithAncestors(payload.fromConcept);
  addWithAncestors(payload.toConcept);
  // Contradictions, and typed relations of the proposal's own kind (the direction rule reads them).
  const relations = readSet.relations.filter(r => r.active && (r.kind === 'contradicts' || r.kind === payload.relationType));
  const claimKeys = new Set([...payload.evidence.map(e => e.claimKey), ...payload.counterevidence.claimKeys, ...relations.map(r => r.claimKey)]);
  const claims = [...claimKeys].sort().map(k => readSet.claims.get(k)).filter((c): c is ReadSetClaim => c !== undefined);
  for (const claim of claims) for (const link of claim.concepts) addWithAncestors(link.code);
  for (const r of relations) { addWithAncestors(r.from); addWithAncestors(r.to); }
  const admittedBridges = readSet.admittedBridges.filter(b => b.relationType === payload.relationType
    && [b.fromConcept, b.toConcept].some(c => c === payload.fromConcept || c === payload.toConcept));
  return {
    concepts: [...codes].sort().map(c => readSet.concepts.get(c)!),
    claims,
    relations: [...relations].sort((a, b) => a.claimKey.localeCompare(b.claimKey) || a.from.localeCompare(b.from)),
    admittedBridges: [...admittedBridges].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function validateBridgeProposal(payload: BridgeProposalPayload, readSet: BridgeReadSet): BridgeDecision {
  const reasons = new Set<BridgeRejectionReason>();
  const notes: string[] = [];
  const reject = (reason: BridgeRejectionReason, note?: string) => { reasons.add(reason); if (note) notes.push(note); };
  const { fromConcept: from, toConcept: to, relationType } = payload;
  const symmetric = SYMMETRIC_BRIDGE_TYPES.includes(relationType);

  const shared = sharedVocabulary(readSet, from, to);
  if (shared.length > 0) notes.push(`shared vocabulary (not evidence): ${shared.join(', ')}`);

  // 1. Concepts.
  if (!readSet.concepts.has(from) || !readSet.concepts.has(to)) {
    reject('concept_unknown');
    return { outcome: 'rejected', validatorVersion: BRIDGE_VALIDATOR_VERSION, reasons: [...reasons], notes };
  }
  if (from === to) reject('same_concept');
  else if (onOneBranch(readSet, from, to)) reject('hierarchy_not_bridge', 'one side is the other\'s ancestor: offer depth, not a bridge');
  if (mechanismIsLabel(payload, readSet)) reject('mechanism_is_label');

  // 2. Every cited claim resolves and is currently supported.
  const cited = (key: string) => readSet.claims.get(key);
  for (const ref of payload.evidence) {
    const claim = cited(ref.claimKey);
    if (!claim) reject('evidence_unresolved', `unknown claim ${ref.claimKey}`);
    else if (claim.status !== 'supported') reject('evidence_unsupported', `claim ${ref.claimKey} has no current source support`);
  }
  const usable = (supports: string) => payload.evidence
    .filter(ref => ref.supports === supports)
    .map(ref => cited(ref.claimKey))
    .filter((claim): claim is ReadSetClaim => claim !== undefined && claim.status === 'supported');

  // Contradictions between the two sides, in either stored orientation.
  const contradictions = readSet.relations.filter(r => r.active && r.kind === 'contradicts'
    && ((onOneBranch(readSet, r.from, from) && onOneBranch(readSet, r.to, to))
      || (onOneBranch(readSet, r.from, to) && onOneBranch(readSet, r.to, from))));

  // A claim that argues against the connection can never also count for it.
  const refuting = new Set([...payload.counterevidence.claimKeys, ...contradictions.map(c => c.claimKey)]);
  for (const ref of payload.evidence) {
    if (refuting.has(ref.claimKey)) reject('counterevidence_cited_as_support', `claim ${ref.claimKey} argues against this connection`);
  }

  // 3. Each side has its own evidence, beyond the claim that connects them: the source must
  // describe both ideas, not only assert the link.
  const mechanismKeys = new Set(payload.evidence.filter(e => e.supports === 'mechanism').map(e => e.claimKey));
  const independent = (side: 'from' | 'to', code: string) => usable(side).some(claim => !mechanismKeys.has(claim.key) && !refuting.has(claim.key) && sideLinks(readSet, claim, code).length > 0);
  if (!independent('from', from)) reject('from_side_unsupported', 'the from side needs a supported claim of its own, besides the connecting one');
  if (!independent('to', to)) reject('to_side_unsupported', 'the to side needs a supported claim of its own, besides the connecting one');

  // 4–5. The mechanism is evidenced, and a directional relation carries its direction.
  const mechanismClaims = usable('mechanism').filter(claim => !refuting.has(claim.key));
  const bridging = mechanismClaims.filter(claim => sideLinks(readSet, claim, from).length > 0 && sideLinks(readSet, claim, to).length > 0);
  let sharedMechanism = false;
  if (symmetric && bridging.length === 0) {
    const mechanismConcepts = (claim: ReadSetClaim) => claim.concepts.filter(l => l.role === 'mechanism').map(l => l.code);
    for (const left of mechanismClaims.filter(c => sideLinks(readSet, c, from).length > 0)) {
      for (const right of mechanismClaims.filter(c => c !== left && sideLinks(readSet, c, to).length > 0)) {
        const common = mechanismConcepts(left).filter(code => mechanismConcepts(right).includes(code)
          && !onOneBranch(readSet, code, from) && !onOneBranch(readSet, code, to));
        if (common.length > 0) { sharedMechanism = true; notes.push(`shared mechanism concept: ${common.join(', ')} (${left.key} + ${right.key})`); }
      }
    }
  }
  if (bridging.length === 0 && !sharedMechanism) {
    reject('mechanism_unsupported', symmetric
      ? 'no cited claim connects both sides, and no pair of cited claims names one shared mechanism'
      : 'a directional bridge needs one cited claim that itself connects both sides');
  } else if (!symmetric && bridging.length > 0) {
    // `explains` is carried by claim roles (the explaining side is the mechanism). Roles cannot tell
    // "applies to" from "comes before", so those need a typed substrate relation of that kind,
    // backed by its own claim, from the same or a broader concept on each side.
    const directed = relationType === 'explains'
      ? bridging.some(claim => {
        const fromRoles = sideLinks(readSet, claim, from).map(l => l.role);
        const toRoles = sideLinks(readSet, claim, to).map(l => l.role);
        return fromRoles.includes('mechanism') && toRoles.some(r => r !== 'mechanism');
      })
      : readSet.relations.some(r => r.active && r.kind === relationType && isWithin(readSet, from, r.from) && isWithin(readSet, to, r.to)
        && readSet.claims.get(r.claimKey)?.status === 'supported');
    if (!directed) reject('direction_unsupported', `nothing in the evidence carries the ${relationType} direction from ${from} to ${to}`);
  }

  // 6. Analogies say where they stop.
  if (symmetric && !payload.limitations.some(l => l.kind === 'analogy_limit')) reject('analogy_limit_missing');

  // 7. Counterevidence.
  for (const key of payload.counterevidence.claimKeys) if (!cited(key)) reject('counterevidence_unresolved', `unknown counterevidence ${key}`);
  if (payload.counterevidence.disposition === 'listed' && payload.counterevidence.claimKeys.length === 0) reject('counterevidence_unresolved', 'listed disposition names no claim');
  for (const c of contradictions) {
    if (!payload.counterevidence.claimKeys.includes(c.claimKey)) reject('counterevidence_ignored', `substrate records ${c.from} contradicts ${c.to} (${c.claimKey})`);
    if (!symmetric) reject('contradicted_by_substrate', `the substrate says ${c.from} does not ${relationType.replace(/_/g, ' ')} ${c.to}`);
  }

  // Duplicates: an admitted bridge already says this.
  const duplicate = readSet.admittedBridges.some(b => b.relationType === relationType
    && ((b.fromConcept === from && b.toConcept === to) || (symmetric && b.fromConcept === to && b.toConcept === from)));
  if (duplicate) reject('duplicate_admitted');

  if (reasons.size > 0) return { outcome: 'rejected', validatorVersion: BRIDGE_VALIDATOR_VERSION, reasons: [...reasons], notes };
  const supportingClaimKeys = [...new Set(payload.evidence.map(e => e.claimKey))].sort();
  return { outcome: 'admitted', validatorVersion: BRIDGE_VALIDATOR_VERSION, supportingClaimKeys, notes };
}
