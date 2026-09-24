/**
 * #132 — which inquiry transport this worker process may use (ADR-0038 §2). Configured only from the
 * worker's own environment: KS_INQUIRY_TRANSPORT=fixture|minimax (unset: inquiries are not processed).
 * `minimax` is the answer path's MiniMax transport — one provider client; when answers already use
 * it, the same instance (and so the same quota readiness window) serves both.
 */
import type { AnswerTransport } from './answer-worker.ts';
import type { InquiryTransport } from './inquiry-worker.ts';
import { createFixtureInquiryTransport, INQUIRY_FIXTURE_MODES, type InquiryFixtureMode } from '../providers/inquiry-fixture.ts';
import { createMiniMaxAnswerTransport } from '../providers/minimax-answer.ts';

export function inquiryTransportsFromEnvironment(env: NodeJS.ProcessEnv, answers?: Partial<Record<'fixture' | 'minimax', AnswerTransport>> | null): Partial<Record<'fixture' | 'minimax', InquiryTransport>> | null {
  const kind = env.KS_INQUIRY_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_INQUIRY_FIXTURE_MODE picks the reply the fixture should produce.
    const mode = (env.KS_INQUIRY_FIXTURE_MODE ?? 'proposal') as InquiryFixtureMode;
    if (!INQUIRY_FIXTURE_MODES.includes(mode)) throw new Error('Unknown KS_INQUIRY_FIXTURE_MODE');
    return { fixture: createFixtureInquiryTransport(() => mode) };
  }
  if (kind === 'minimax') {
    if (answers?.minimax) return { minimax: answers.minimax };
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey) throw new Error('KS_INQUIRY_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment');
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_INQUIRY_TRANSPORT must be fixture or minimax');
}
