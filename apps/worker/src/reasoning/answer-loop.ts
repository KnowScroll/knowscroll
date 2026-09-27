/**
 * #132 — which answer transport this worker process may use (ADR-0033 §2). Configured only from the
 * worker's own environment: KS_ANSWER_TRANSPORT=fixture|minimax (unset: answers are not processed).
 * `minimax` additionally needs an `sk-cp-` subscription key in MINIMAX_API_KEY, read here and
 * nowhere else; the API process never reads it.
 */
import type { AnswerTransport } from './answer-worker.ts';
import { createFixtureAnswerTransport, type FixtureMode } from '../providers/answer-fixture.ts';
import { createMiniMaxAnswerTransport, type MiniMaxTransport } from '../providers/minimax-answer.ts';

export function answerTransportsFromEnvironment(env: NodeJS.ProcessEnv): { fixture?: AnswerTransport; minimax?: MiniMaxTransport } | null {
  const kind = env.KS_ANSWER_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_ANSWER_FIXTURE_MODE picks a failure the fixture should produce.
    const mode = (env.KS_ANSWER_FIXTURE_MODE ?? 'answer') as FixtureMode;
    if (!['answer', 'not_in_source', 'invented_quote', 'http_error', 'transport_loss', 'hang'].includes(mode)) throw new Error('Unknown KS_ANSWER_FIXTURE_MODE');
    return { fixture: createFixtureAnswerTransport(() => mode) };
  }
  if (kind === 'minimax') {
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey) throw new Error('KS_ANSWER_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment');
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_ANSWER_TRANSPORT must be fixture or minimax');
}
