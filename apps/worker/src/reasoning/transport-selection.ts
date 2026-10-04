/**
 * Which provider transports this worker process may use, read only from its own environment:
 * KS_ANSWER_TRANSPORT, KS_INQUIRY_TRANSPORT and KS_SCROLL_TRANSPORT (each fixture|minimax; unset
 * means that work is not processed). MiniMax is one provider client: when answers already use it,
 * the same instance (and so the same quota readiness window) serves inquiries and Scroll writing.
 */
import {
  createFixtureAnswerTransport,
  type FixtureMode,
} from '../providers/fixtures/answer.ts';
import {
  createFixtureInquiryTransport,
  INQUIRY_FIXTURE_MODES,
  type InquiryFixtureMode,
} from '../providers/fixtures/inquiry.ts';
import {
  createFixtureScrollTransport,
  SCROLL_FIXTURE_MODES,
  type ScrollFixtureMode,
} from '../providers/fixtures/scroll.ts';
import {
  createMiniMaxAnswerTransport,
  type MiniMaxTransport,
} from '../providers/minimax-answer.ts';
import type {
  AnswerTransport,
  InquiryTransport,
  ScrollTransport,
} from '../providers/transports.ts';

type ScrollTransports = Partial<Record<'fixture' | 'minimax', ScrollTransport>>;

/**
 * Which answer transport this worker process may use (ADR-0033 §2). Configured only from the
 * worker's own environment: KS_ANSWER_TRANSPORT=fixture|minimax (unset: answers are not processed).
 * `minimax` additionally needs an `sk-cp-` subscription key in MINIMAX_API_KEY, read here and
 * nowhere else; the API process never reads it.
 */
export function answerTransportsFromEnvironment(
  env: NodeJS.ProcessEnv,
): { fixture?: AnswerTransport; minimax?: MiniMaxTransport } | null {
  const kind = env.KS_ANSWER_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_ANSWER_FIXTURE_MODE picks a failure the fixture should produce.
    const mode = (env.KS_ANSWER_FIXTURE_MODE ?? 'answer') as FixtureMode;
    if (
      ![
        'answer',
        'not_in_source',
        'invented_quote',
        'http_error',
        'transport_loss',
        'hang',
      ].includes(mode)
    )
      throw new Error('Unknown KS_ANSWER_FIXTURE_MODE');
    return { fixture: createFixtureAnswerTransport(() => mode) };
  }
  if (kind === 'minimax') {
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey)
      throw new Error(
        'KS_ANSWER_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment',
      );
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_ANSWER_TRANSPORT must be fixture or minimax');
}

/**
 * Which inquiry transport this worker process may use (ADR-0038 §2). Configured only from the
 * worker's own environment: KS_INQUIRY_TRANSPORT=fixture|minimax (unset: inquiries are not processed).
 * `minimax` is the answer path's MiniMax transport — one provider client; when answers already use
 * it, the same instance (and so the same quota readiness window) serves both.
 */
export function inquiryTransportsFromEnvironment(
  env: NodeJS.ProcessEnv,
  answers?: { minimax?: MiniMaxTransport } | null,
): Partial<Record<'fixture' | 'minimax', InquiryTransport>> | null {
  const kind = env.KS_INQUIRY_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_INQUIRY_FIXTURE_MODE picks the reply the fixture should produce.
    const mode = (env.KS_INQUIRY_FIXTURE_MODE ??
      'proposal') as InquiryFixtureMode;
    if (!INQUIRY_FIXTURE_MODES.includes(mode))
      throw new Error('Unknown KS_INQUIRY_FIXTURE_MODE');
    return { fixture: createFixtureInquiryTransport(() => mode) };
  }
  if (kind === 'minimax') {
    if (answers?.minimax) return { minimax: answers.minimax };
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey)
      throw new Error(
        'KS_INQUIRY_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment',
      );
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_INQUIRY_TRANSPORT must be fixture or minimax');
}

/**
 * Which Scroll-writing transport this worker process may use. Configured only from the worker's own
 * environment: KS_SCROLL_TRANSPORT=fixture|minimax (unset: supply requests are not written).
 * `minimax` needs a subscription (`sk-cp-`) key in MINIMAX_API_KEY; when answers already use MiniMax,
 * that same client (and so the same quota readiness) serves Scroll writing too.
 */
export function scrollTransportsFromEnvironment(
  env: NodeJS.ProcessEnv,
  answers?: Partial<Record<'fixture' | 'minimax', AnswerTransport>> | null,
): ScrollTransports | null {
  const kind = env.KS_SCROLL_TRANSPORT;
  if (!kind) return null;
  if (kind === 'fixture') {
    // Test/journey only: KS_SCROLL_FIXTURE_MODE picks the reply the fixture should produce.
    const mode = (env.KS_SCROLL_FIXTURE_MODE ?? 'scroll') as ScrollFixtureMode;
    if (!SCROLL_FIXTURE_MODES.includes(mode))
      throw new Error('Unknown KS_SCROLL_FIXTURE_MODE');
    return { fixture: createFixtureScrollTransport(() => mode) };
  }
  if (kind === 'minimax') {
    if (answers?.minimax) return { minimax: answers.minimax };
    const apiKey = env.MINIMAX_API_KEY;
    if (!apiKey)
      throw new Error(
        'KS_SCROLL_TRANSPORT=minimax needs MINIMAX_API_KEY in the worker environment',
      );
    // The transport itself refuses anything but a subscription (sk-cp-) key.
    return { minimax: createMiniMaxAnswerTransport({ apiKey }) };
  }
  throw new Error('KS_SCROLL_TRANSPORT must be fixture or minimax');
}
