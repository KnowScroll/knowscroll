/**
 * #162 — one model-written Scroll from one page (ADR-0041 §2–§7): fetch, write, check, admit.
 *
 * The plan's concepts must exist; the page must come from the allowlist and, if the substrate
 * already holds it, be unchanged. The request is built and hashed; a material and request already
 * decided are never sent again. Only then is the caller's `beforeSend` gate asked, and exactly one
 * request sent, never retried. The reply is judged by scroll-checks-v2 and either admitted (the
 * Scroll, its claims and the private material, in one transaction) or recorded as refused with its
 * reason codes. The operator CLI (`scripts/scrolls/write-scrolls.ts`) supplies the transport and a
 * gate of quota preflight plus the session ledger; a worker loop supplies its own route's.
 */
import { createHash } from 'node:crypto';
import { MATERIAL_POLICY_VERSION, offeredText } from '../../../../packages/core/src/scrolls/material.ts';
import { judgeScrollReply, SCROLL_LIMITS, SCROLL_WRITING_VERSIONS, serializeScrollWritingRequest, type ScrollPlanItem } from '../../../../packages/core/src/scrolls/writing.ts';
import { transaction } from '../../../../packages/db/src/index.ts';
import { admitModelScroll, findScrollWriting, loadConceptOffer, recordRefusedScroll, sourceStanding } from '../../../../packages/db/src/semantic/model-scrolls.ts';
import type { AnswerObservation } from '../reasoning/answer-worker.ts';
import type { InquiryTransport } from '../reasoning/inquiry-worker.ts';
import { fetchMaterial } from './fetch-material.ts';

/** The inquiry path's seam: exactly the given bytes, sent once; the minimal receipt and the reply
 * text. The MiniMax transport (`providers/minimax-answer.ts`) serves answers, inquiries and Scrolls. */
export type ScrollTransport = InquiryTransport;

export interface WriteScrollDeps {
  transport: ScrollTransport;
  model: string;
  /** false: fetch and build only, reporting the request's size and hash; nothing is sent or written. */
  apply: boolean;
  /** Asked once, just before the one request; a refusal sends nothing. */
  beforeSend(signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface ScrollItemResult {
  url: string;
  /**
   * `admitted`: a new Scroll. `refused`: this page or reply may not become one. `already_decided`:
   * this material and request were decided before (with that decision's reasons and Scroll).
   * `ready`: built, not sent (no apply). `not_sent`: the gate refused. `failed`: the one request
   * brought back no reply to judge. The last two are refusals of the route.
   */
  status: 'admitted' | 'refused' | 'already_decided' | 'ready' | 'not_sent' | 'failed';
  reasons: string[];
  materialSha256: string | null;
  requestSha256: string | null;
  inputBytes: number | null;
  httpStatus: number | null;
  usage: AnswerObservation['usage'] | null;
  assetId: string | null;
  writingId: string | null;
}

const VERSIONS = Object.freeze({ ...SCROLL_WRITING_VERSIONS, hosts: MATERIAL_POLICY_VERSION });

export async function writeScroll(deps: WriteScrollDeps, item: ScrollPlanItem): Promise<ScrollItemResult> {
  const nothing: ScrollItemResult = {
    url: item.url, status: 'refused', reasons: [], materialSha256: null, requestSha256: null, inputBytes: null, httpStatus: null, usage: null, assetId: null, writingId: null,
  };
  const { offered, known } = await transaction(c => loadConceptOffer(c, item.conceptCodes));
  if (offered.length !== item.conceptCodes.length) return { ...nothing, reasons: ['plan_concept_unknown'] };
  const fetched = await fetchMaterial(item.url, { fetchImpl: deps.fetchImpl, signal: deps.signal, now: deps.now });
  if (!fetched.ok) return { ...nothing, reasons: [fetched.reason], httpStatus: fetched.reason === 'http_status' ? fetched.httpStatus : null };
  const material = fetched.material;

  const { body } = serializeScrollWritingRequest({ material: offeredText(material), concepts: offered }, { model: deps.model, maxOutputTokens: SCROLL_LIMITS.maxOutputTokens });
  const identity = { materialSha256: material.contentSha256, requestSha256: createHash('sha256').update(body).digest('hex') };
  const built: ScrollItemResult = { ...nothing, url: material.url, ...identity, inputBytes: body.length };
  const { standing, prior } = await transaction(async c => ({ standing: await sourceStanding(c, material.url, identity.materialSha256), prior: await findScrollWriting(c, identity) }));
  if (prior) return { ...built, status: 'already_decided', reasons: prior.reasons, assetId: prior.assetId, writingId: prior.writingId };
  if (standing === 'changed') return { ...built, reasons: ['source_changed'] };
  if (!deps.apply) return { ...built, status: 'ready' };

  const gate = await deps.beforeSend(deps.signal);
  if (!gate.ok) return { ...built, status: 'not_sent', reasons: [gate.reason] };
  let observed: AnswerObservation;
  // A lost transport may still have reached the provider: it is reported, never retried.
  try { observed = await deps.transport.send({ body, maxOutputTokens: SCROLL_LIMITS.maxOutputTokens, signal: deps.signal }); }
  catch { return { ...built, status: 'failed', reasons: ['transport_lost'] }; }
  const sent: ScrollItemResult = { ...built, httpStatus: observed.httpStatus, usage: observed.usage };
  if (observed.outcome !== 'success') return { ...sent, status: 'failed', reasons: [`provider_${observed.outcome}`] };

  const record = { transport: deps.transport.kind, model: deps.model, inputBytes: body.length, usage: observed.usage, versions: VERSIONS };
  const verdict = judgeScrollReply(observed.text ?? '', { material: material.text, offered: item.conceptCodes, known });
  const decided = await transaction(c => verdict.ok
    ? admitModelScroll(c, { identity, material: { url: material.url, title: material.title, host: material.host, text: material.text, retrievedAt: material.retrievedAt }, scroll: verdict.scroll, record })
    : recordRefusedScroll(c, { identity, url: material.url, reasons: verdict.reasons, record }));
  return {
    ...sent, status: decided.status, reasons: decided.status === 'admitted' ? [] : decided.reasons,
    writingId: decided.writingId, assetId: decided.status === 'refused' ? null : decided.assetId,
  };
}
