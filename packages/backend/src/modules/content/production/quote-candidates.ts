import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../infrastructure/receipts/index.js';
import { RESEARCH_POLICY, researchUrl, type ResearchPage } from '../../../infrastructure/research/public-pages.js';

export const QUOTE_CANDIDATE_POLICY = 'quote-candidates.v1';
export const MAX_QUOTE_CANDIDATES = 32;
const MIN_CHARS = 40;
// Both quote and statement are the same source text; the canonical statement ceiling is 600.
const MAX_CHARS = 600;
export type QuoteCandidate = {
  readonly policyVersion: typeof QUOTE_CANDIDATE_POLICY;
  readonly id: string;
  readonly pageId: string;
  readonly pageUrl: string;
  readonly pageSha256: string;
  readonly passageId: string;
  /** Exact UTF-16 substring offsets into the immutable extracted passage. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly sha256: string;
};
export type ClaimPackage = {
  readonly claims: {
    readonly claimId: string;
    readonly pageId: string;
    readonly passageId: string;
    readonly statement: string;
    readonly quote: string;
    /** A direct source quotation, not proof of the source's truth or semantic entailment. */
    readonly truthState: 'documented';
  }[];
};
export class QuoteCandidateRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'QuoteCandidateRefusal';
  }
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const refuse = (code: string): never => {
  throw new QuoteCandidateRefusal(code);
};

/**
 * Conservative, fixed sentence boundaries for long paragraphs. An abbreviation/initial does not
 * end a sentence. Unpunctuated tails and oversized sentences refuse the pool; never clip them.
 * Short paragraphs are already whole source units and need no sentence segmentation.
 */
function spans(text: string): readonly { readonly start: number; readonly end: number }[] {
  if (text.length <= MAX_CHARS) return [{ start: 0, end: text.length }];
  const sentences: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of text.matchAll(/[.!?。！？]["'”’\])]*(?=\s|$)/gu)) {
    const punctuation = match.index;
    const end = punctuation + match[0].length;
    if (text[punctuation] === '.' && end < text.length) {
      const word = /([A-Za-z.]+)$/u.exec(text.slice(start, punctuation))?.[1] ?? '';
      const following = text.slice(end).trimStart();
      if (
        /^[a-z]/u.test(following) ||
        /^(?:[A-Za-z]|(?:[A-Za-z]\.)+[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|approx|Fig|Figs|Eq|No)$/iu.test(word)
      )
        continue;
    }
    sentences.push({ start, end });
    start = end;
    while (/\s/u.test(text[start] ?? '') && start < text.length) start++;
  }
  if (start !== text.length || sentences.length > 128) return refuse('candidate_sentence_boundary');
  // Partition on whole sentence boundaries, including a short final caveat. Look ahead rather
  // than greedily dropping a short tail or cutting the previous sentence to make it fit.
  const next = new Map<number, number>([[sentences.length, sentences.length]]);
  for (let from = sentences.length - 1; from >= 0; from--) {
    for (let through = sentences.length - 1; through >= from; through--) {
      const length = (sentences[through]?.end ?? 0) - (sentences[from]?.start ?? 0);
      if (length >= MIN_CHARS && length <= MAX_CHARS && next.has(through + 1)) {
        next.set(from, through + 1);
        break;
      }
    }
  }
  if (!next.has(0)) return refuse('candidate_sentence_partition');
  const result: { start: number; end: number }[] = [];
  for (let from = 0; from < sentences.length;) {
    const after = next.get(from);
    const first = sentences[from];
    const last = after === undefined ? undefined : sentences[after - 1];
    if (after === undefined || first === undefined || last === undefined) return refuse('candidate_sentence_partition');
    result.push({ start: first.start, end: last.end });
    from = after;
  }
  return result;
}

/** Rebuilds the same bounded pool from verified frozen originals; no normalisation or network. */
export function quoteCandidates(pages: readonly ResearchPage[]): readonly QuoteCandidate[] {
  if (pages.length < 1 || pages.length > 8) return refuse('candidate_research_bounds');
  const candidates: QuoteCandidate[] = [];
  const pageIds = new Set<string>();
  const candidateIds = new Set<string>();
  const claimIds = new Set<string>();
  for (const page of pages) {
    researchUrl(page.url);
    if (pageIds.has(page.id)) return refuse('candidate_identity_collision');
    pageIds.add(page.id);
    const original = page.passages.map((passage) => passage.text).join('\n');
    if (
      page.policyVersion !== RESEARCH_POLICY ||
      original.length < 400 ||
      original.length + 1 > 8000 ||
      page.sha256 !== digest(original) ||
      page.id !== `page-${page.sha256.slice(0, 24)}`
    )
      return refuse('candidate_research_integrity');
    const passageIds = new Set<string>();
    for (const passage of page.passages) {
      if (passageIds.has(passage.id)) return refuse('candidate_identity_collision');
      passageIds.add(passage.id);
      if (
        passage.text.length < 60 ||
        passage.text.length > 2400 ||
        passage.id !== `p-${digest(passage.text).slice(0, 24)}`
      )
        return refuse('candidate_research_integrity');
      for (const { start, end } of spans(passage.text)) {
        const text = passage.text.slice(start, end);
        if (text.length < MIN_CHARS || text.length > MAX_CHARS) return refuse('candidate_span_bounds');
        const identity = {
          policyVersion: QUOTE_CANDIDATE_POLICY,
          pageId: page.id,
          pageUrl: page.url,
          pageSha256: page.sha256,
          passageId: passage.id,
          start,
          end,
          text,
        } as const;
        const sha256 = digest(canonicalJson(identity));
        const id = `q-${sha256.slice(0, 48)}`;
        const claimId = `claim-${sha256.slice(0, 40)}`;
        if (candidateIds.has(id) || claimIds.has(claimId)) return refuse('candidate_identity_collision');
        candidateIds.add(id);
        claimIds.add(claimId);
        candidates.push(Object.freeze({ ...identity, id, sha256 }));
        if (candidates.length > MAX_QUOTE_CANDIDATES) return refuse('candidate_pool_too_large');
      }
    }
  }
  if (candidates.length < 4) return refuse('candidate_pool_insufficient');
  return Object.freeze(candidates);
}

/** Check persisted hydrated claims against the same immutable originals before writer resume. */
export function verifyHydratedClaims(
  pages: readonly ResearchPage[],
  offered: readonly QuoteCandidate[],
  stored: ClaimPackage,
): void {
  const byClaim = new Map(offered.map((candidate) => [`claim-${candidate.sha256.slice(0, 40)}`, candidate.id]));
  const selected = stored.claims.map((claim) => byClaim.get(claim.claimId) ?? '');
  if (canonicalJson(hydrateSelectedClaims(pages, offered, selected)) !== canonicalJson(stored))
    return refuse('candidate_stored_claim_integrity');
}

/**
 * Revalidate original hashes, offsets and the complete offered pool before hydration, including on
 * ledger replay. The model only selects IDs: it cannot assert a new claim, edit a quote or choose
 * its truth state. Every hydrated statement/quote is the identical original source substring.
 */
export function hydrateSelectedClaims(
  pages: readonly ResearchPage[],
  offered: readonly QuoteCandidate[],
  candidateIds: readonly string[],
): ClaimPackage {
  const verified = quoteCandidates(pages);
  if (canonicalJson(verified) !== canonicalJson(offered)) return refuse('candidate_pool_integrity');
  if (candidateIds.length < 4 || candidateIds.length > 8) return refuse('candidate_selection_bounds');
  if (new Set(candidateIds).size !== candidateIds.length) return refuse('candidate_selection_duplicate');
  const byId = new Map(verified.map((candidate) => [candidate.id, candidate]));
  return {
    claims: candidateIds.map((id) => {
      const candidate = byId.get(id);
      if (candidate === undefined) return refuse('candidate_not_offered');
      return {
        claimId: `claim-${candidate.sha256.slice(0, 40)}`,
        pageId: candidate.pageId,
        passageId: candidate.passageId,
        statement: candidate.text,
        quote: candidate.text,
        truthState: 'documented',
      };
    }),
  };
}
