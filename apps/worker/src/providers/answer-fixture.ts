/**
 * #132 — a deterministic, labelled fixture answer transport for tests and journeys (ADR-0033 §2).
 * It never calls a network. Its default reply quotes the Scroll's first sentence verbatim, so the
 * real validator accepts it; the other modes produce the failures the answer path must survive.
 * Replies from this transport are fixture evidence, never a live provider result.
 */
import type { AnswerObservation, AnswerTransport } from '../reasoning/answer-worker.ts';

export type FixtureMode = 'answer' | 'not_in_source' | 'invented_quote' | 'http_error' | 'transport_loss' | 'hang';

const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costMicroUsd: null };

function scrollBody(body: Uint8Array): string {
  const request = JSON.parse(new TextDecoder().decode(body)) as { messages: { content: string }[] };
  const content = request.messages[0]!.content;
  return content.slice(content.indexOf('\nBody:\n') + '\nBody:\n'.length);
}

export function createFixtureAnswerTransport(mode: () => FixtureMode = () => 'answer', calls: { count: number } = { count: 0 }): AnswerTransport {
  return {
    kind: 'fixture',
    async send({ body, signal }): Promise<AnswerObservation> {
      calls.count += 1;
      const m = mode();
      if (m === 'transport_loss') throw new Error('fixture transport loss');
      if (m === 'hang') {
        await new Promise<void>((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
      }
      if (m === 'http_error') return { remoteDisposition: 'terminal', outcome: 'error', httpStatus: 500, usage, text: null };
      const first = (scrollBody(body).match(/[^.!?]{12,400}[.!?]/)?.[0] ?? '').trim();
      const reply = m === 'not_in_source'
        ? { answer: null, basis: [], limits: 'Fixture: the Scroll does not cover this question.' }
        : { answer: `Fixture answer drawn from the Scroll: ${first}`, basis: [{ quote: m === 'invented_quote' ? 'A sentence this Scroll never contained at all.' : first.replace(/[.!?]$/, '') }], limits: 'Fixture reply; not a live provider result.' };
      return { remoteDisposition: 'terminal', outcome: 'success', httpStatus: 200, usage, text: JSON.stringify(reply) };
    },
  };
}
