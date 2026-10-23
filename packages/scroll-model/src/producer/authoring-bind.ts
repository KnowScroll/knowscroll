import type { AnyBlock } from '../blocks/catalog.js';
import { addressedTexts, type HonestyDocument } from '../internal/honesty.js';
import type { ProvenanceBinding } from '../internal/provenance.js';
import type { Issue } from '../issues.js';
import { isUnitExponent, numericTokens, sentenceRanges } from '../text.js';

/**
 * The evidence a writer may cite. `claimIdOf` maps a handle the writer sees (`e1`) to a claim id;
 * `quoteOf` maps a claim id to the source text it stands for.
 */
export interface AuthoringEvidence {
  readonly claimIdOf: ReadonlyMap<string, string>;
  readonly quoteOf: ReadonlyMap<string, string>;
  /** The document must cite at least this many distinct passages. */
  readonly minDistinctCitations: number;
}

/** The number as written, without thousands separators: `4,096` and `4096` are the same figure. */
const figure = (token: string): string => token.replaceAll(',', '');

function figuresIn(text: string): Set<string> {
  return new Set(numericTokens(text).map(([start, end]) => figure(text.slice(start, end))));
}

/** Every number a chart plots, in reading order. */
function plottedNumbers(block: Extract<AnyBlock, { type: 'chart' }>): number[] {
  const spec = block.data.spec;
  if (spec.kind === 'bar') return spec.series.flatMap((series) => series.values);
  if (spec.kind === 'heatmap') return spec.values.flat();
  return spec.series.flatMap((series) => series.points.flat());
}

const PLACEHOLDER = /\{[a-z][a-zA-Z0-9]{0,23}\}/gu;

/** Figures of a claim's source text, computed once per claim. */
function figureIndex(evidence: AuthoringEvidence): (claimId: string) => Set<string> {
  const byClaim = new Map<string, Set<string>>();
  return (claimId) => {
    let known = byClaim.get(claimId);
    if (known === undefined) {
      known = figuresIn(evidence.quoteOf.get(claimId) ?? '');
      byClaim.set(claimId, known);
    }
    return known;
  };
}

/** What each block and section of the assembled document cites, and where the writer wrote it. */
interface Citations {
  readonly claimsOfBlock: Map<string, readonly string[]>;
  readonly pathOfBlock: Map<string, string>;
  readonly claimsOfSection: Map<string, readonly string[]>;
  readonly pathOfSection: Map<string, string>;
  readonly all: Set<string>;
}

/**
 * Resolves every block's handles to claims, binds the block to each (`block` bindings), and checks
 * what a block's own data states: a chart plots only figures a cited passage contains.
 */
function bindCitations(
  document: HonestyDocument,
  blockCites: readonly (readonly (readonly string[])[])[],
  evidence: AuthoringEvidence,
  figuresOfClaim: (claimId: string) => Set<string>,
  out: { readonly bindings: ProvenanceBinding[]; readonly issues: Issue[] },
): Citations {
  const citations: Citations = {
    claimsOfBlock: new Map(),
    pathOfBlock: new Map(),
    claimsOfSection: new Map(),
    pathOfSection: new Map(),
    all: new Set(),
  };
  document.sections.forEach((section, sectionIndex) => {
    const sectionClaims = new Set<string>();
    citations.pathOfSection.set(section.id, `sections.${sectionIndex}.heading`);
    section.blocks.forEach((block, blockIndex) => {
      const path = `sections.${sectionIndex}.blocks.${blockIndex}`;
      const claims: string[] = [];
      for (const handle of blockCites[sectionIndex]?.[blockIndex] ?? []) {
        const claimId = evidence.claimIdOf.get(handle);
        if (claimId === undefined) out.issues.push({ code: 'authoring_cite_unknown', path });
        else if (!claims.includes(claimId)) claims.push(claimId);
      }
      if (block.type === 'chart') {
        const known = claims.map(figuresOfClaim);
        const invented = plottedNumbers(block).some(
          (value) => value !== 0 && !known.some((figures) => figures.has(String(value))),
        );
        if (invented) out.issues.push({ code: 'authoring_number_not_in_evidence', path });
      }
      for (const claimId of claims) {
        out.bindings.push({ kind: 'block', claimId, blockId: block.id });
        sectionClaims.add(claimId);
        citations.all.add(claimId);
      }
      citations.claimsOfBlock.set(block.id, claims);
      citations.pathOfBlock.set(block.id, path);
    });
    citations.claimsOfSection.set(section.id, [...sectionClaims]);
  });
  return citations;
}

/**
 * Anchors every sentence of a reader-facing text that states a number to a cited claim whose
 * source text contains that figure. A header may rest on any passage the document cites, a heading
 * on any of its section's, a block's text on its own.
 */
function anchorFigures(
  document: HonestyDocument,
  citations: Citations,
  figuresOfClaim: (claimId: string) => Set<string>,
  out: { readonly bindings: ProvenanceBinding[]; readonly issues: Issue[] },
): void {
  for (const entry of addressedTexts(document)) {
    if (entry.code || entry.address === 'header:kicker') continue;
    const [kind = '', second = '', ...rest] = entry.address.split(':');
    const candidates =
      kind === 'block'
        ? (citations.claimsOfBlock.get(second) ?? [])
        : kind === 'heading'
          ? (citations.claimsOfSection.get(second) ?? [])
          : [...citations.all];
    // A readout template's `{key}` placeholders are keys, not numbers.
    const placeholders = entry.address.endsWith(':data.readout.template')
      ? [...entry.text.matchAll(PLACEHOLDER)].map((match) => [match.index, match.index + match[0].length] as const)
      : [];
    let missing = false;
    for (const [from, to] of sentenceRanges(entry.text)) {
      const supporting = new Set<string>();
      for (const [start, end] of numericTokens(entry.text)) {
        if (start < from || end > to) continue;
        if (placeholders.some(([open, close]) => open <= start && end <= close)) continue;
        if (entry.unit && isUnitExponent(entry.text, [start, end])) continue;
        const claimId = candidates.find((candidate) =>
          figuresOfClaim(candidate).has(figure(entry.text.slice(start, end))),
        );
        if (claimId === undefined) missing = true;
        else supporting.add(claimId);
      }
      for (const claimId of supporting) {
        if (kind === 'header')
          out.bindings.push({ kind: 'header', claimId, field: second as 'title' | 'dek', start: from, end: to });
        else if (kind === 'heading')
          out.bindings.push({ kind: 'heading', claimId, sectionId: second, start: from, end: to });
        else
          out.bindings.push({
            kind: 'passage',
            claimId,
            blockId: second,
            field: rest.join(':'),
            start: from,
            end: to,
          });
      }
    }
    if (missing) {
      const path =
        kind === 'block'
          ? citations.pathOfBlock.get(second)
          : kind === 'heading'
            ? citations.pathOfSection.get(second)
            : second;
      out.issues.push({ code: 'authoring_number_not_in_evidence', path: path ?? '$' });
    }
  }
}

/**
 * Derives the claim bindings of an authored document from the passages each block cites.
 *
 * - Every block rests on each claim it cites (a `block` binding), which is what makes a block
 *   "bound" for the reader-block and chart checks.
 * - Every number a chart plots must appear in a passage the chart cites (zero excepted), so a chart
 *   cannot carry invented data.
 * - Every sentence of any reader-facing text that states a number is anchored to a cited claim
 *   whose source text contains that same figure, so a figure can never be invented. A figure that
 *   appears in no cited passage is an `authoring_number_not_in_evidence` finding at the block.
 * - The document must cite at least `minDistinctCitations` different passages.
 *
 * Pure: the same document and citations always give the same bindings, in document order.
 */
export function deriveBindings(
  document: HonestyDocument,
  blockCites: readonly (readonly (readonly string[])[])[],
  evidence: AuthoringEvidence,
): { readonly bindings: ProvenanceBinding[]; readonly issues: Issue[] } {
  const out = { bindings: [] as ProvenanceBinding[], issues: [] as Issue[] };
  const figuresOfClaim = figureIndex(evidence);
  const citations = bindCitations(document, blockCites, evidence, figuresOfClaim, out);
  if (citations.all.size < evidence.minDistinctCitations)
    out.issues.push({ code: 'authoring_too_few_cites', path: '$' });
  anchorFigures(document, citations, figuresOfClaim, out);
  return out;
}
