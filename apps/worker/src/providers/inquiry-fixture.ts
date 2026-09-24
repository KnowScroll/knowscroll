/**
 * #132 — a deterministic, labelled fixture transport for background bridge inquiries (ADR-0038),
 * for tests and journeys only. It never calls a network. Its default reply proposes a bridge for the
 * first offered pair that has a claim naming both sides, citing only offered claims, so the real
 * validator can admit it; the other modes produce the replies the inquiry path must survive.
 * Replies from this transport are fixture evidence, never a live provider result.
 */
import { INQUIRY_PAIRS_MARKER } from '../../../../packages/core/src/reasoning/bridge-inquiry.ts';
import type { AnswerObservation } from '../reasoning/answer-worker.ts';
import type { InquiryTransport } from '../reasoning/inquiry-worker.ts';

export type InquiryFixtureMode = 'proposal' | 'none' | 'prose' | 'unoffered_claim' | 'invalid_bridge' | 'http_error' | 'transport_loss' | 'hang';
export const INQUIRY_FIXTURE_MODES: readonly InquiryFixtureMode[] = ['proposal', 'none', 'prose', 'unoffered_claim', 'invalid_bridge', 'http_error', 'transport_loss', 'hang'];

type Offered = { key: string };
type OfferedPair = { a: { code: string; name: string }; b: { code: string; name: string }; claimsAboutA: Offered[]; claimsAboutB: Offered[]; claimsNamingBoth: Offered[] };
const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null };

function offeredPairs(body: Uint8Array): OfferedPair[] {
  const request = JSON.parse(new TextDecoder().decode(body)) as { messages: { content: string }[] };
  const content = request.messages[0]!.content;
  return JSON.parse(content.slice(content.indexOf(INQUIRY_PAIRS_MARKER) + INQUIRY_PAIRS_MARKER.length)) as OfferedPair[];
}

function reply(mode: InquiryFixtureMode, pairs: OfferedPair[]): unknown {
  const pair = pairs.find(p => p.claimsNamingBoth.length > 0);
  if (mode === 'none' || !pair) return { none: true };
  const mechanism = pair.claimsNamingBoth[0]!.key;
  const from = pair.claimsAboutA[0]?.key ?? pair.claimsNamingBoth[1]?.key ?? mechanism;
  const to = pair.claimsAboutB[0]?.key ?? pair.claimsNamingBoth[1]?.key ?? mechanism;
  const evidence = mode === 'invalid_bridge'
    // Every side cites only the connecting claim: the validator refuses sides without their own evidence.
    ? [{ claimKey: mechanism, supports: 'from' }, { claimKey: mechanism, supports: 'to' }, { claimKey: mechanism, supports: 'mechanism' }]
    : [{ claimKey: from, supports: 'from' }, { claimKey: to, supports: 'to' }, { claimKey: mode === 'unoffered_claim' ? 'clm.fixture.never_offered' : mechanism, supports: 'mechanism' }];
  return {
    proposal: {
      fromConcept: pair.a.code, toConcept: pair.b.code, relationType: 'compares_mechanism',
      mechanism: `Fixture: ${pair.a.name} and ${pair.b.name} are linked through one offered claim that describes a single process acting on both of them.`,
      prerequisites: [{ statement: 'Fixture prerequisite: read both places first.' }],
      limitations: [{ kind: 'analogy_limit', statement: 'Fixture reply; the comparison stops at the offered claims.' }],
      evidence,
      counterevidence: { disposition: 'searched_none_found', searchedScope: 'the offered claims', claimKeys: [] },
    },
  };
}

export function createFixtureInquiryTransport(mode: () => InquiryFixtureMode = () => 'proposal', calls: { count: number } = { count: 0 }): InquiryTransport {
  return {
    kind: 'fixture',
    async send({ body, signal }): Promise<AnswerObservation> {
      calls.count += 1;
      const m = mode();
      if (m === 'transport_loss') throw new Error('fixture transport loss');
      if (m === 'hang') await new Promise<void>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      if (m === 'http_error') return { remoteDisposition: 'terminal', outcome: 'error', httpStatus: 500, usage, text: null };
      const text = m === 'prose' ? 'These two places seem related in an interesting way.' : JSON.stringify(reply(m, offeredPairs(body)));
      return { remoteDisposition: 'terminal', outcome: 'success', httpStatus: 200, usage, text };
    },
  };
}
