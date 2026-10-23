import type { Issue } from '../issues.js';
import { issueFromSchema, uniqueIssues } from '../issues.js';
import { deriveBindings, type AuthoringEvidence } from './authoring-bind.js';
import { convertAuthored, type AuthoredPositions } from './authoring-convert.js';
import type { AuthoredScroll } from './authoring-schema.js';
import { analyseDraft, finishCompile, type CompileOutcome } from './compile.js';
import { DraftProvenance, ScrollDraft } from './draft.js';

const AUTHORED_BLOCK = /^blocks\.\d+/u;
const CANONICAL_BLOCK = /^sections\.(\d+)\.blocks\.(\d+)/u;
const CANONICAL_HEADING = /^sections\.(\d+)\.heading/u;

/**
 * Where the writer wrote what a finding is about: `blocks.7` for a block or its heading, `title`,
 * `dek`, or `$`. Findings about the assembled document (`sections.1.blocks.2.data.x`) are mapped
 * back through the converter's positions; the converter's own findings are already authored paths.
 */
function authoredPath(path: string, positions: AuthoredPositions | undefined): string {
  const authored = AUTHORED_BLOCK.exec(path)?.[0];
  if (authored !== undefined) return authored;
  const block = CANONICAL_BLOCK.exec(path);
  const index = block === null ? undefined : positions?.blocks[Number(block[1])]?.[Number(block[2])];
  if (index !== undefined) return `blocks.${index}`;
  const heading = CANONICAL_HEADING.exec(path);
  const headingIndex = heading === null ? undefined : positions?.headings[Number(heading[1])];
  if (headingIndex !== undefined && headingIndex !== null) return `blocks.${headingIndex}`;
  if (path === 'title' || path.startsWith('title@') || path.startsWith('title.')) return 'title';
  if (path === 'dek' || path.startsWith('dek@') || path.startsWith('dek.')) return 'dek';
  return '$';
}

function refusal(
  stage: Extract<CompileOutcome, { kind: 'refused' }>['stage'],
  issues: readonly Issue[],
  positions?: AuthoredPositions,
): CompileOutcome {
  const located = issues.map((issue) => ({ code: issue.code, path: authoredPath(issue.path, positions) }));
  // A figure with no support in the cited passages is reported once, with the fix that applies here.
  const unsupported = new Set(
    located.filter((issue) => issue.code === 'authoring_number_not_in_evidence').map((issue) => issue.path),
  );
  return {
    kind: 'refused',
    stage,
    issues: uniqueIssues(located.filter((issue) => !(issue.code === 'number_unbound' && unsupported.has(issue.path)))),
  };
}

/**
 * Compiles an authored document into the consumer document and its internal provenance.
 *
 * Inputs: the structurally valid authored document, the publication identity and the evidence
 * package (`provenance.claims`, which must hold every passage the writer could cite, and the
 * research text the copy check compares against), and the handle → claim mapping.
 * Output: `compiled`, or `refused` with the stage and findings, each located at the authored
 * block or header it concerns (`blocks.7`, `title`), never at a canonical field.
 * Side effects: none. The same input always gives the same output.
 *
 * Code derives the claim bindings from each block's citations (`deriveBindings`); then every
 * canonical check runs: structure, simulation grid proof, honesty (numbers), copy limits, reading
 * length and the stored-document admission.
 */
export function compileAuthored(
  authored: AuthoredScroll,
  provenance: DraftProvenance,
  evidence: AuthoringEvidence,
): CompileOutcome {
  const checkedProvenance = DraftProvenance.safeParse(provenance);
  if (!checkedProvenance.success) return refusal('envelope', [{ code: 'provenance_mismatch', path: '$' }]);
  const converted = convertAuthored(authored);
  if (converted.kind === 'refused') return refusal('structure', converted.issues);
  const parsed = ScrollDraft.safeParse(converted.draft);
  if (!parsed.success) return refusal('schema', parsed.error.issues.map(issueFromSchema), converted.positions);
  const analysis = analyseDraft(parsed.data, checkedProvenance.data, (document) =>
    deriveBindings(document, converted.blockCites, evidence),
  );
  if ('kind' in analysis) return refusal(analysis.stage, analysis.issues, converted.positions);
  const compiled = finishCompile(analysis);
  return compiled.kind === 'refused' ? refusal(compiled.stage, compiled.issues, converted.positions) : compiled;
}
