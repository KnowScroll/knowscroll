/**
 * #162 — a deterministic, labelled fixture transport for Scroll writing (ADR-0041 §7), for tests and
 * journeys only. It never calls a network. Its default reply is a labelled stand-in Scroll about the
 * first offered concept whose two claims quote the first two sentences of the offered material
 * verbatim, so the real checks admit it; the other modes produce the replies the writing path must
 * survive. Replies from this transport are fixture evidence, never a live provider result.
 */
import { MATERIAL_MARKER, OFFERED_CONCEPTS_MARKER, type OfferedConcept } from '../../../../packages/core/src/scrolls/writing.ts';
import type { AnswerObservation } from '../reasoning/answer-worker.ts';
import type { ScrollTransport } from '../scrolls/write-scroll.ts';

export type ScrollFixtureMode = 'scroll' | 'invented_quote' | 'copied_passage' | 'prose' | 'http_error' | 'transport_loss';
export const SCROLL_FIXTURE_MODES: readonly ScrollFixtureMode[] = ['scroll', 'invented_quote', 'copied_passage', 'prose', 'http_error', 'transport_loss'];

const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null };

function offer(body: Uint8Array): { concepts: OfferedConcept[]; material: string } {
  const request = JSON.parse(new TextDecoder().decode(body)) as { messages: { content: string }[] };
  const content = request.messages[0]!.content;
  const conceptsAt = content.indexOf(`${OFFERED_CONCEPTS_MARKER}\n`) + OFFERED_CONCEPTS_MARKER.length + 1;
  const materialAt = content.indexOf(`\n\n${MATERIAL_MARKER}\n`);
  return { concepts: JSON.parse(content.slice(conceptsAt, materialAt)) as OfferedConcept[], material: content.slice(materialAt + MATERIAL_MARKER.length + 3) };
}

function reply(mode: ScrollFixtureMode, body: Uint8Array): unknown {
  const { concepts, material } = offer(body);
  const [primary, ...rest] = concepts;
  const sentences = (material.match(/[^.!?]{40,300}[.!?]/g) ?? []).slice(0, 2).map(s => s.trim());
  return {
    title: `Fixture: ${primary!.name}`,
    summary: `A labelled fixture Scroll about ${primary!.name}, not a live model result.`,
    beats: [
      `Fixture beat one: a hand-made stand-in for model prose about ${primary!.name}.`,
      // copied_passage: the material's own opening words, which the checks refuse.
      mode === 'copied_passage' ? material.split(' ').slice(0, 16).join(' ') : 'Fixture beat two: it lets tests and journeys admit a Scroll without a provider.',
      'Fixture beat three: its claims quote the offered material word for word.',
    ],
    concepts: [{ code: primary!.code, role: 'primary' }, ...rest.map(c => ({ code: c.code, role: 'secondary' }))],
    claims: sentences.map((quote, index) => ({
      statement: `Fixture claim ${index + 1} about ${primary!.name}, quoted from the material.`,
      truthState: 'documented',
      concepts: [{ code: primary!.code, role: 'subject' }],
      quote: mode === 'invented_quote' && index === 0 ? 'A sentence this material never contained at all.' : quote,
      supportKind: 'supports',
    })),
  };
}

export function createFixtureScrollTransport(mode: () => ScrollFixtureMode = () => 'scroll', calls: { count: number } = { count: 0 }): ScrollTransport {
  return {
    kind: 'fixture',
    async send({ body }): Promise<AnswerObservation> {
      calls.count += 1;
      const m = mode();
      if (m === 'transport_loss') throw new Error('fixture transport loss');
      if (m === 'http_error') return { remoteDisposition: 'terminal', outcome: 'error', httpStatus: 500, usage, text: null };
      const text = m === 'prose' ? 'Here is a Scroll about the offered concept.' : JSON.stringify(reply(m, body));
      return { remoteDisposition: 'terminal', outcome: 'success', httpStatus: 200, usage, text };
    },
  };
}
