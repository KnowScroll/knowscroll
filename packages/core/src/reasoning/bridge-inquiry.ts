/**
 * #132 — the pure background bridge inquiry boundary (ADR-0038 §5 and §7). Three functions, no I/O:
 *
 * `selectInquiryPairs` decides what a model may be shown: at most three pairs of the reader's live
 * planets/regions that nothing connects yet, each with the currently supported claims about its two
 * anchors and the claims that name both, in a deterministic order.
 *
 * `serializeBridgeInquiryRequest` turns the sealed pairs into the exact request bytes. Admission
 * reserves their hash; the worker rebuilds the same bytes from the same sealed context.
 *
 * `parseBridgeInquiryReply` decides what provider text may become: one bridge proposal for an offered
 * pair that cites only offered claims (still only a proposal — bridge-validator-v1 decides), an honest
 * "none", or a shape rejection naming the rule it broke. Provider text carries no authority of its own.
 */
import { bridgeProposalPayload, type BridgeProposalPayload } from '../../../contracts/src/semantic.ts';

export const BRIDGE_INQUIRY_VERSIONS = Object.freeze({ selection: 'inquiry-pairs-v1', prompt: 'bridge-inquiry-prompt-v2', reply: 'bridge-inquiry-reply-v1' });
export const BRIDGE_INQUIRY_LIMITS = Object.freeze({ maxPairs: 3, claimsPerAnchor: 8, claimsBoth: 8 });

export interface InquiryPlace { placeId: string; code: string; name: string }
export interface InquirySubstrateClaim {
  key: string; statement: string; sourceTitle: string;
  /** A `supports` quote on a current snapshot (`claim_is_supported`). */
  supported: boolean;
  links: readonly { code: string; role: 'subject' | 'object' | 'mechanism' | 'context' }[];
}
export interface InquiryCandidateInput {
  /** The reader's live planets and regions (never sightings). */
  places: readonly InquiryPlace[];
  parentOf: ReadonlyMap<string, string | null>;
  claims: readonly InquirySubstrateClaim[];
  /** Active substrate relations and admitted bridges (shared or this universe), any kind. */
  connections: readonly { from: string; to: string }[];
  /** Bridges this reader said seem wrong. */
  suppressed: readonly { from: string; to: string }[];
  /** Pairs already put to an inquiry in this epoch. */
  asked: readonly (readonly [string, string])[];
}
/** `roles` (claims naming both sides only): each side's role in the claim, in the validator's terms. */
export interface OfferedClaim { key: string; statement: string; sourceTitle: string; roles?: Record<string, string> }
export interface InquiryPair { a: InquiryPlace; b: InquiryPlace; claimsA: OfferedClaim[]; claimsB: OfferedClaim[]; both: OfferedClaim[] }

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (x: string, y: string) => (x < y ? `${x}\0${y}` : `${y}\0${x}`);

function ancestors(parentOf: ReadonlyMap<string, string | null>, code: string): string[] {
  const out: string[] = [];
  const seen = new Set([code]);
  for (let p = parentOf.get(code) ?? null; p !== null && !seen.has(p); p = parentOf.get(p) ?? null) { out.push(p); seen.add(p); }
  return out;
}

/**
 * How a claim bears on a side, in the validator's own terms (bridge-validator-v1 `sideLinks`): a
 * non-context link to the side's concept or a broader one. Evidence never generalises upward, so a
 * claim about a narrower concept says nothing about the side. Returns the linked codes by distance.
 */
function linksAbout(claim: InquirySubstrateClaim, chain: readonly string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const link of claim.links) {
    if (link.role === 'context') continue;
    const distance = chain.indexOf(link.code);
    if (distance >= 0 && (found.get(link.code) ?? Infinity) > distance) found.set(link.code, distance);
  }
  return found;
}

const offered = (c: InquirySubstrateClaim): OfferedClaim => ({ key: c.key, statement: c.statement, sourceTitle: c.sourceTitle });

/** The role a claim gives one side: that of its nearest non-context link on the side's chain. */
function roleOn(claim: InquirySubstrateClaim, chain: readonly string[]): string | undefined {
  let best: { distance: number; role: string } | undefined;
  for (const link of claim.links) {
    if (link.role === 'context') continue;
    const distance = chain.indexOf(link.code);
    if (distance >= 0 && (!best || distance < best.distance)) best = { distance, role: link.role };
  }
  return best?.role;
}

export function selectInquiryPairs(input: InquiryCandidateInput): InquiryPair[] {
  const places = [...input.places].sort((x, y) => byCode(x.code, y.code));
  const claims = input.claims.filter(c => c.supported);
  const chain = new Map(places.map(p => [p.code, [p.code, ...ancestors(input.parentOf, p.code)]]));
  const blocked = new Set([...input.connections, ...input.suppressed].map(r => pairKey(r.from, r.to)));
  for (const [x, y] of input.asked) blocked.add(pairKey(x, y));

  const pairs: (InquiryPair & { named: boolean })[] = [];
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      const a = places[i]!, b = places[j]!;
      const chainA = chain.get(a.code)!, chainB = chain.get(b.code)!;
      // A place and its own ancestor are one branch: depth, which the validator refuses as a bridge.
      if (chainA.includes(b.code) || chainB.includes(a.code) || blocked.has(pairKey(a.code, b.code))) continue;
      const sideA: { claim: InquirySubstrateClaim; distance: number }[] = [];
      const sideB: typeof sideA = [];
      const both: InquirySubstrateClaim[] = [];
      for (const claim of claims) {
        const aboutA = linksAbout(claim, chainA), aboutB = linksAbout(claim, chainB);
        // It names both only through two different concepts: a claim about a shared ancestor names neither.
        const ownA = [...aboutA.keys()].filter(code => !aboutB.has(code));
        const ownB = [...aboutB.keys()].filter(code => !aboutA.has(code));
        if (ownA.length > 0 && ownB.length > 0) { both.push(claim); continue; }
        if (aboutA.size > 0) sideA.push({ claim, distance: Math.min(...aboutA.values()) });
        if (aboutB.size > 0) sideB.push({ claim, distance: Math.min(...aboutB.values()) });
      }
      const rank = (list: typeof sideA) => list.sort((x, y) => x.distance - y.distance || byCode(x.claim.key, y.claim.key))
        .slice(0, BRIDGE_INQUIRY_LIMITS.claimsPerAnchor).map(x => offered(x.claim));
      const claimsA = rank(sideA), claimsB = rank(sideB);
      // A claim naming both says which role each side plays in it: "explains" is carried by those roles.
      const named = both.sort((x, y) => byCode(x.key, y.key)).slice(0, BRIDGE_INQUIRY_LIMITS.claimsBoth)
        .map(c => ({ ...offered(c), roles: { [a.code]: roleOn(c, chainA) ?? 'subject', [b.code]: roleOn(c, chainB) ?? 'subject' } }));
      // Each side needs a supported claim of its own, or no proposal could ever be admitted.
      if (claimsA.length + named.length === 0 || claimsB.length + named.length === 0) continue;
      pairs.push({ a, b, claimsA, claimsB, both: named, named: named.length > 0 });
    }
  }
  return pairs
    .sort((x, y) => Number(y.named) - Number(x.named) || byCode(x.a.code, y.a.code) || byCode(x.b.code, y.b.code))
    .slice(0, BRIDGE_INQUIRY_LIMITS.maxPairs)
    .map(({ named: _named, ...pair }) => pair);
}

const SYSTEM = [
  'You look for one real, sourced connection between two places a reader has explored, using only the claims provided.',
  'Reply with exactly one JSON object and nothing else.',
  'If no offered pair has a connection the offered claims support, reply {"none": true}.',
  'Otherwise reply {"proposal": P}, where P is:',
  '{"fromConcept": code, "toConcept": code, "relationType": "explains" | "analogous_in" | "compares_mechanism",',
  ' "mechanism": how the two actually connect (40 to 600 characters, not the relation word or the two names alone),',
  ' "prerequisites": [{"statement": 8 to 280 characters}] (1 to 5),',
  ' "limitations": [{"kind": "analogy_limit" | "scope_limit" | "evidence_limit", "statement": 8 to 280 characters}] (1 to 5),',
  ' "evidence": [{"claimKey": key, "supports": "from" | "to" | "mechanism" | "limitation"}] (3 to 12),',
  ' "counterevidence": {"disposition": "listed" | "searched_none_found", "searchedScope": 4 to 200 characters, "claimKeys": [key]}}.',
  'fromConcept and toConcept are the two codes of one offered pair. Cite only claim keys offered for that pair.',
  'Each side needs a claim of its own ("from", "to") besides the one that connects them; the connecting claim, cited as "mechanism", must name both sides.',
  'Use "explains" only when a claim naming both gives fromConcept the role "mechanism" and toConcept a different role (see its "roles").',
  '"analogous_in" and "compares_mechanism" need a limitation of kind "analogy_limit".',
  'List under counterevidence only offered claims that argue against the connection, and never one you cite as evidence.',
  'If none argues against it, use {"disposition": "searched_none_found", "searchedScope": "the offered claims", "claimKeys": []}.',
  'Do not describe or guess anything about the reader.',
].join('\n');

/** Stable key order, so equal inputs give equal bytes and therefore an equal reserved hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const INQUIRY_PAIRS_MARKER = 'Offered pairs (JSON):';

export function serializeBridgeInquiryRequest(pairs: readonly InquiryPair[], route: { model: string; maxOutputTokens: number }): Uint8Array {
  const claim = (c: OfferedClaim) => ({ key: c.key, statement: c.statement, source: c.sourceTitle, ...(c.roles ? { roles: c.roles } : {}) });
  // Codes, names and claims only: no place, universe or reader identifier leaves the process.
  const offeredPairs = pairs.map(p => ({
    a: { code: p.a.code, name: p.a.name }, b: { code: p.b.code, name: p.b.name },
    claimsAboutA: p.claimsA.map(claim), claimsAboutB: p.claimsB.map(claim), claimsNamingBoth: p.both.map(claim),
  }));
  return new TextEncoder().encode(canonical({
    model: route.model,
    max_tokens: route.maxOutputTokens,
    // A single JSON reply; hidden reasoning would spend the bounded output budget.
    thinking: { type: 'disabled' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `${INQUIRY_PAIRS_MARKER}\n${canonical(offeredPairs)}` }],
  }));
}

export type InquiryShapeReason = 'not_one_json_object' | 'reply_keys' | 'payload_invalid' | 'pair_not_offered' | 'claim_not_offered';
export type InquiryReply =
  | { kind: 'proposal'; payload: BridgeProposalPayload }
  | { kind: 'none' }
  | { kind: 'shape'; reasons: ['shape', InquiryShapeReason] };

/** The whole reply, after dropping reasoning blocks, as one JSON object: bare, or as the only content
 * of a single fenced block. Prose around it is not "exactly one JSON object" (ADR-0038 §7). */
function wholeObject(text: string): Record<string, unknown> | undefined {
  let body = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function parseBridgeInquiryReply(text: string, pairs: readonly InquiryPair[]): InquiryReply {
  const shape = (reason: InquiryShapeReason): InquiryReply => ({ kind: 'shape', reasons: ['shape', reason] });
  const value = wholeObject(text);
  if (!value) return shape('not_one_json_object');
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'none' && value.none === true) return { kind: 'none' };
  if (keys.length !== 1 || keys[0] !== 'proposal') return shape('reply_keys');
  const parsed = bridgeProposalPayload.safeParse(value.proposal);
  if (!parsed.success) return shape('payload_invalid');
  const payload = parsed.data;
  const pair = pairs.find(p => pairKey(p.a.code, p.b.code) === pairKey(payload.fromConcept, payload.toConcept) && payload.fromConcept !== payload.toConcept);
  if (!pair) return shape('pair_not_offered');
  const offeredKeys = new Set([...pair.claimsA, ...pair.claimsB, ...pair.both].map(c => c.key));
  const cited = [...payload.evidence.map(e => e.claimKey), ...payload.counterevidence.claimKeys];
  if (cited.some(key => !offeredKeys.has(key))) return shape('claim_not_offered');
  return { kind: 'proposal', payload };
}
