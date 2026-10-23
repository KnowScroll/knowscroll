import { createHash } from 'node:crypto';
import type { AuthoringEvidence } from '@knowscroll/scroll-model/producer';
import type { ResearchPage } from '../../../infrastructure/research/public-pages.js';

/**
 * The evidence a writer may cite: the frozen research text cut into passages the writer sees as
 * `[e1]`, `[e2]`, … Code builds the passages from stored pages and later maps each cited handle
 * back to the exact source text, so a claim is always a substring of research code fetched.
 */
export interface EvidencePassage {
  /** What the writer cites. */
  readonly handle: string;
  /** Stable identity of this stretch of this page, recorded in the Scroll's provenance. */
  readonly claimId: string;
  readonly pageId: string;
  readonly text: string;
}

export class EvidenceRefusal extends Error {
  constructor(readonly code: 'evidence_insufficient') {
    super(code);
    this.name = 'EvidenceRefusal';
  }
}

/** At least this many passages must exist for a Scroll to be grounded; the writer must cite as many. */
export const MIN_EVIDENCE_PASSAGES = 4;
/** More passages than this are not offered; the earliest in page order stay. */
export const MAX_EVIDENCE_PASSAGES = 64;
const MIN_CHARS = 40;
// The canonical claim statement is at most 600 characters.
const MAX_CHARS = 600;

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Cuts a paragraph into passages of 40 to 600 characters at sentence ends. A paragraph that fits
 * is one passage. A long one is split only where a sentence ends (an abbreviation or initial does
 * not end one), keeping a short last sentence with its neighbour. Text that cannot be split this
 * way is left out rather than clipped.
 */
function passagesOf(text: string): readonly { readonly start: number; readonly end: number }[] {
  if (text.length <= MAX_CHARS) return text.length >= MIN_CHARS ? [{ start: 0, end: text.length }] : [];
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
  if (start !== text.length || sentences.length > 128) return [];
  // Group whole sentences into passages. `next[i]` is where the group starting at sentence i ends;
  // looking ahead keeps a short closing caveat with its neighbour instead of dropping it.
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
  const groups: { start: number; end: number }[] = [];
  for (let from = 0; from < sentences.length; ) {
    const after = next.get(from);
    const first = sentences[from];
    const last = after === undefined ? undefined : sentences[after - 1];
    if (after === undefined || first === undefined || last === undefined) return [];
    groups.push({ start: first.start, end: last.end });
    from = after;
  }
  return groups;
}

/**
 * The passages offered to the writer for a set of frozen research pages, in page order. Pure and
 * deterministic: the same pages always give the same handles and claim IDs, so a resumed job sees
 * what the first attempt saw. Throws `EvidenceRefusal` when fewer than four passages exist.
 */
export function evidencePassages(pages: readonly ResearchPage[]): readonly EvidencePassage[] {
  const passages: EvidencePassage[] = [];
  for (const page of pages) {
    for (const source of page.passages) {
      for (const { start, end } of passagesOf(source.text)) {
        const text = source.text.slice(start, end);
        const claimId = `claim-${digest(`${page.id}\n${source.id}\n${start}\n${end}\n${text}`).slice(0, 40)}`;
        passages.push({ handle: `e${passages.length + 1}`, claimId, pageId: page.id, text });
      }
    }
  }
  if (passages.length < MIN_EVIDENCE_PASSAGES) throw new EvidenceRefusal('evidence_insufficient');
  return passages.slice(0, MAX_EVIDENCE_PASSAGES);
}

/** The context text the writer reads: one line per passage, `[e7] text`. */
export function evidenceText(passages: readonly EvidencePassage[]): string {
  return passages.map((passage) => `[${passage.handle}] ${passage.text}`).join('\n');
}

/** What the authoring compiler needs to resolve cited handles and check figures against sources. */
export function authoringEvidence(passages: readonly EvidencePassage[]): AuthoringEvidence {
  return {
    claimIdOf: new Map(passages.map((passage) => [passage.handle, passage.claimId])),
    quoteOf: new Map(passages.map((passage) => [passage.claimId, passage.text])),
    minDistinctCitations: MIN_EVIDENCE_PASSAGES,
  };
}
