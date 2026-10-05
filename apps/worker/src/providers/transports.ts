/**
 * The provider transport seams: what the answer, inquiry and Scroll-writing loops send, and what
 * every transport (fixture or MiniMax) returns. Exactly the reserved bytes go out, once; the minimal
 * receipt and the reply come back. Types only, so no provider imports a worker loop (ADR-0033,
 * ADR-0038, ADR-0041, ADR-0042).
 */
import type { reasoningUsage } from '@knowscroll/contracts/reasoning';
import type { AssistantBlock } from '@knowscroll/core/reasoning/bridge-inquiry';
import type { AnswerWork } from '@knowscroll/db/reasoning/answers';
import type { z } from 'zod';

type ReasoningUsage = z.infer<typeof reasoningUsage>;

/** What a provider transport observed: the minimal receipt fields, plus the reply text for the validator only. */
export type AnswerObservation = {
  remoteDisposition: 'terminal' | 'unconfirmed';
  outcome: 'success' | 'refusal' | 'error' | 'unclassified';
  httpStatus: number | null;
  usage: ReasoningUsage;
  text: string | null;
};
export interface AnswerTransport {
  readonly kind: 'fixture' | 'minimax';
  /** Checked before anything is scheduled or reserved (e.g. provider quota); false leaves the queue untouched. */
  ready?(
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(input: {
    body: Uint8Array;
    maxOutputTokens: number;
    signal: AbortSignal;
    work: AnswerWork;
  }): Promise<AnswerObservation>;
}

/** What an inquiry transport observed: the answer path's fields, plus the assistant turn's native content
 * blocks and stop reason (ADR-0042 §1–§2). Protected: never logged, stored only for a continuation. */
export type InquiryObservation = AnswerObservation & {
  content: AssistantBlock[];
  stopReason: string | null;
};
/** The same transport seam as answers: exactly the reserved bytes, the minimal receipt, the reply. */
export interface InquiryTransport {
  readonly kind: 'fixture' | 'minimax';
  ready?(
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(input: {
    body: Uint8Array;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<InquiryObservation>;
}

/** The inquiry path's seam: exactly the given bytes, sent once; the minimal receipt and the reply
 * text. The MiniMax transport (`providers/minimax-answer.ts`) serves answers, inquiries and Scrolls; a
 * Scroll reads only the text, never an inquiry's continuation turn (ADR-0042), so it asks for the
 * answer-level observation. */
export interface ScrollTransport
  extends Pick<InquiryTransport, 'kind' | 'ready'> {
  send(input: {
    body: Uint8Array;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<AnswerObservation>;
}
