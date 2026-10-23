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
 *   A header text may rest on any passage the document cites, a heading on any of its section's.
 *
 * Pure: the same document and citations always give the same bindings, in document order.
 */
export function deriveBindings(
  document: HonestyDocument,
  blockCites: readonly (readonly (readonly string[])[])[],
  evidence: AuthoringEvidence,
): { readonly bindings: ProvenanceBinding[]; readonly issues: Issue[] } {
  const bindings: ProvenanceBinding[] = [];
  const issues: Issue[] = [];
  const figuresByClaim = new Map<string, Set<string>>();
  const figuresOfClaim = (claimId: string): Set<string> => {
    let known = figuresByClaim.get(claimId);
    if (known === undefined) {
      known = figuresIn(evidence.quoteOf.get(claimId) ?? '');
      figuresByClaim.set(claimId, known);
    }
    return known;
  };
  const claimsOfBlock = new Map<string, readonly string[]>();
  const claimsOfSection = new Map<string, readonly string[]>();
  const pathOfBlock = new Map<string, string>();
  const pathOfSection = new Map<string, string>();
  const allClaims = new Set<string>();

  document.sections.forEach((section, sectionIndex) => {
    const sectionClaims = new Set<string>();
    pathOfSection.set(section.id, `sections.${sectionIndex}.heading`);
    section.blocks.forEach((block, blockIndex) => {
      const path = `sections.${sectionIndex}.blocks.${blockIndex}`;
      const claims: string[] = [];
      for (const handle of blockCites[sectionIndex]?.[blockIndex] ?? []) {
        const claimId = evidence.claimIdOf.get(handle);
        if (claimId === undefined) issues.push({ code: 'authoring_cite_unknown', path });
        else if (!claims.includes(claimId)) claims.push(claimId);
      }
      if (block.type === 'chart') {
        const known = claims.map((claimId) => figuresOfClaim(claimId));
        const invented = plottedNumbers(block).some(
          (value) => value !== 0 && !known.some((figures) => figures.has(String(value))),
        );
        if (invented) issues.push({ code: 'authoring_number_not_in_evidence', path });
      }
      for (const claimId of claims) {
        bindings.push({ kind: 'block', claimId, blockId: block.id });
        sectionClaims.add(claimId);
        allClaims.add(claimId);
      }
      claimsOfBlock.set(block.id, claims);
      pathOfBlock.set(block.id, path);
    });
    claimsOfSection.set(section.id, [...sectionClaims]);
  });
  if (allClaims.size < evidence.minDistinctCitations) issues.push({ code: 'authoring_too_few_cites', path: '$' });

  for (const entry of addressedTexts(document)) {
    if (entry.code || entry.address === 'header:kicker') continue;
    const [kind = '', second = '', ...rest] = entry.address.split(':');
    const candidates =
      kind === 'block'
        ? (claimsOfBlock.get(second) ?? [])
        : kind === 'heading'
          ? (claimsOfSection.get(second) ?? [])
          : [...allClaims];
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
          bindings.push({ kind: 'header', claimId, field: second as 'title' | 'dek', start: from, end: to });
        else if (kind === 'heading')
          bindings.push({ kind: 'heading', claimId, sectionId: second, start: from, end: to });
        else bindings.push({ kind: 'passage', claimId, blockId: second, field: rest.join(':'), start: from, end: to });
      }
    }
    if (missing) {
      const path =
        kind === 'block' ? pathOfBlock.get(second) : kind === 'heading' ? pathOfSection.get(second) : second;
      issues.push({ code: 'authoring_number_not_in_evidence', path: path ?? '$' });
    }
  }
  return { bindings, issues };
}
