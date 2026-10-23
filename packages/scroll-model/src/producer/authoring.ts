import type { Issue } from '../issues.js';
import { issueFromSchema, uniqueIssues } from '../issues.js';
import { deriveBindings, type AuthoringEvidence } from './authoring-bind.js';
import { convertAuthored } from './authoring-convert.js';
import type { AuthoredScroll } from './authoring-schema.js';
import { analyseDraft, finishCompile, type CompileOutcome } from './compile.js';
import { DraftProvenance, ScrollDraft } from './draft.js';

/** `sections.1.blocks.2.data.x` → `sections.1.blocks.2`: findings are reported where the writer wrote the block. */
const BLOCK_PREFIX = /^sections\.\d+\.(?:blocks\.\d+|heading)/u;

function authoredPath(path: string): string {
  const prefix = BLOCK_PREFIX.exec(path)?.[0];
  if (prefix !== undefined) return prefix;
  if (path === 'title' || path.startsWith('title@') || path.startsWith('title.')) return 'title';
  if (path === 'dek' || path.startsWith('dek@') || path.startsWith('dek.')) return 'dek';
  return '$';
}

function refusal(
  stage: Extract<CompileOutcome, { kind: 'refused' }>['stage'],
  issues: readonly Issue[],
): CompileOutcome {
  const located = issues.map((issue) => ({ code: issue.code, path: authoredPath(issue.path) }));
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
 * block, heading or header it concerns (`sections.1.blocks.2`), never at a canonical field.
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
  if (!parsed.success) return refusal('schema', parsed.error.issues.map(issueFromSchema));
  const analysis = analyseDraft(parsed.data, checkedProvenance.data, (document) =>
    deriveBindings(document, converted.blockCites, evidence),
  );
  if ('kind' in analysis) return refusal(analysis.stage, analysis.issues);
  const compiled = finishCompile(analysis);
  return compiled.kind === 'refused' ? refusal(compiled.stage, compiled.issues) : compiled;
}
