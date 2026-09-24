/**
 * #132 — a deterministic, labelled fixture transport for background bridge inquiries (ADR-0038), for
 * tests and journeys only. It never calls a network. Its default reply proposes a bridge for the first
 * offered pair that has a claim naming both sides, citing only offered claims, so the real validator can
 * admit it; the other modes produce the replies the inquiry path must survive. A continuation (ADR-0042
 * §1) is recognised by the refused turn the request carries: `refused_then_valid` first proposes what
 * the validator refuses, then a valid proposal when continued. When the request asks for adaptive
 * thinking, each reply starts with a labelled fixture thinking block, as M3's would.
 * Replies from this transport are fixture evidence, never a live provider result.
 */
import { INQUIRY_PAIRS_MARKER, type AssistantBlock } from '../../../../packages/core/src/reasoning/bridge-inquiry.ts';
import type { InquiryObservation, InquiryTransport } from '../reasoning/inquiry-worker.ts';

export type InquiryFixtureMode = 'proposal' | 'none' | 'prose' | 'unoffered_claim' | 'invalid_bridge' | 'refused_then_valid' | 'refused_then_hang'
  | 'truncated' | 'http_error' | 'transport_loss' | 'hang';
export const INQUIRY_FIXTURE_MODES: readonly InquiryFixtureMode[] = ['proposal', 'none', 'prose', 'unoffered_claim', 'invalid_bridge', 'refused_then_valid',
  'refused_then_hang', 'truncated', 'http_error', 'transport_loss', 'hang'];

type Offered = { key: string };
type OfferedPair = { index: number; a: { code: string; name: string }; b: { code: string; name: string }; claimsAboutA: Offered[]; claimsAboutB: Offered[]; claimsNamingBoth: Offered[];
  admissible: { index: number; relationType: string; fromConcept: string; toConcept: string }[] };
type Request = { thinking: { type: string }; messages: { role: string; content: unknown }[] };
const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null };
const THINKING: AssistantBlock = { type: 'thinking', thinking: 'Fixture thinking block: a labelled stand-in, not model output.', signature: 'fixture-signature' };

/** A call that never answers: it ends only when its caller gives up. */
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });

function offeredPairs(request: Request): OfferedPair[] {
  const content = String(request.messages[0]!.content);
  return JSON.parse(content.slice(content.indexOf(INQUIRY_PAIRS_MARKER) + INQUIRY_PAIRS_MARKER.length)) as OfferedPair[];
}

function reply(mode: 'proposal' | 'none' | 'unoffered_claim' | 'invalid_bridge', pairs: OfferedPair[]): unknown {
  const pair = pairs.find(p => p.claimsNamingBoth.length > 0);
  if (mode === 'none' || !pair) return { none: true };
  const mechanism = pair.claimsNamingBoth[0]!.key;
  const aSide = pair.claimsAboutA[0]?.key ?? pair.claimsNamingBoth[1]?.key ?? mechanism;
  const bSide = pair.claimsAboutB[0]?.key ?? pair.claimsNamingBoth[1]?.key ?? mechanism;
  const relation = (kind: string) => pair.admissible.find(r => r.relationType === kind)!.index;
  // Reply v2 (prompt v4): indexes and cited keys; the system composes the typed proposal.
  return {
    proposal: {
      pair: pair.index,
      relation: relation(mode === 'invalid_bridge' ? 'analogous_in' : 'compares_mechanism'),
      mechanism: `Fixture: ${pair.a.name} and ${pair.b.name} are linked through one offered claim that describes a single process acting on both of them.`,
      prerequisites: [{ statement: 'Fixture prerequisite: read both places first.' }],
      // invalid_bridge: an analogy that never says where it stops, which the validator refuses.
      limitations: mode === 'invalid_bridge'
        ? [{ kind: 'scope_limit', statement: 'Fixture reply; the offered claims only.' }]
        : [{ kind: 'analogy_limit', statement: 'Fixture reply; the comparison stops at the offered claims.' }],
      cite: [aSide, bSide, mode === 'unoffered_claim' ? 'clm.fixture.never_offered' : mechanism],
      counterevidence: { disposition: 'searched_none_found', searchedScope: 'the offered claims', claimKeys: [] },
    },
  };
}

export function createFixtureInquiryTransport(mode: () => InquiryFixtureMode = () => 'proposal', calls: { count: number } = { count: 0 }): InquiryTransport {
  return {
    kind: 'fixture',
    async send({ body, signal }): Promise<InquiryObservation> {
      calls.count += 1;
      const request = JSON.parse(new TextDecoder().decode(body)) as Request;
      const continued = request.messages.length > 1;
      const m = mode();
      if (m === 'transport_loss') throw new Error('fixture transport loss');
      if (m === 'hang' || (m === 'refused_then_hang' && continued)) return untilAborted(signal);
      if (m === 'http_error') return { remoteDisposition: 'terminal', outcome: 'error', httpStatus: 500, usage, text: null, content: [], stopReason: null };
      const thinking = request.thinking.type === 'adaptive' ? [THINKING] : [];
      // truncated: the thinking used the whole output budget and no answer followed (ADR-0042 §2).
      if (m === 'truncated') return { remoteDisposition: 'terminal', outcome: 'success', httpStatus: 200, usage, text: '', content: [THINKING], stopReason: 'max_tokens' };
      const shaped = m === 'refused_then_valid' || m === 'refused_then_hang' ? (continued ? 'proposal' : 'invalid_bridge') : m;
      const text = shaped === 'prose' ? 'These two places seem related in an interesting way.' : JSON.stringify(reply(shaped, offeredPairs(request)));
      return { remoteDisposition: 'terminal', outcome: 'success', httpStatus: 200, usage, text, content: [...thinking, { type: 'text', text }], stopReason: 'end_turn' };
    },
  };
}
