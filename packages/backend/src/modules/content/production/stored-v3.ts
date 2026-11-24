import { validateDocumentV3 } from '@knowscroll/scroll-model';
import { SCROLL_PROVENANCE_V3_SCHEMA_VERSION, ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import type { WrittenScrollV3 } from '@knowscroll/scroll-model/producer';
import { readingFactsOfV3 } from '../adapters/reading-facts-v3.js';
import type { AdmissionIssue, CompileOutcome } from '../application/ports.js';
import { compileGeneratedScrollV3, type WriterV3Context } from './writer-v3.js';
import { WRITER_V3_PROMPT_VERSION } from './writer-v3-version.js';

/** Who made the Scroll: the writer run and the paid attempts that produced the accepted answer. */
export interface ModelProduction {
  readonly runId: string;
  readonly attemptIds: readonly string[];
  readonly model: string;
}

/** The most findings a refusal carries, as in the editorial compile. */
const MOST_ISSUES = 32;

/** A stored refusal keeps the code and the path only: the copy detail (D-441) is for the repair notes and is never stored. */
const asIssues = (issues: readonly AdmissionIssue[]): AdmissionIssue[] =>
  issues.slice(0, MOST_ISSUES).map(({ code, path }) => ({ code, path }));

/**
 * Compiles the document v3 writer's accepted reply into what admission stores: the consumer document, the private
 * `scroll-provenance.v3` with the claims every beat, aside, picture and the takeaway cite, and the reading facts (v4).
 *
 * The production record names the real writer run and its paid attempts, and `WRITER_V3_PROMPT_VERSION`: the value the
 * publication lineage (`storedLineage`) requires of a stored v3 revision, not the role's own version (`scroll-writer-v3a.v3`,
 * which only names the arm in the attempt ledger).
 *
 * Refuses, with codes and paths and never text, what the producer refuses (at the model's own items, so a repair can fix it),
 * and a document or provenance that does not hold once written out as the exact stored bytes. A link the producer could not
 * place is not a refusal: the document is stored without it and `notices` says where it was (D-438). Pure and deterministic.
 */
export function storedScrollV3(
  reply: WrittenScrollV3,
  context: WriterV3Context,
  production: ModelProduction,
): CompileOutcome {
  const generated = compileGeneratedScrollV3(reply, context, {
    kind: 'model',
    runId: production.runId,
    attemptIds: [...production.attemptIds],
    model: production.model,
    promptVersion: WRITER_V3_PROMPT_VERSION,
  });
  if (generated.kind === 'refused') return { kind: 'refused', stage: 'authoring', issues: asIssues(generated.issues) };
  // The stored bytes are what the reader gets: admit exactly those.
  const stored = JSON.parse(JSON.stringify(generated.document)) as Record<string, unknown>;
  const admitted = validateDocumentV3(stored);
  if (admitted.kind !== 'valid') return { kind: 'refused', stage: 'admission', issues: asIssues(admitted.issues) };
  if (admitted.notices.length > 0) return { kind: 'refused', stage: 'admission', issues: asIssues(admitted.notices) };
  const document = admitted.document;
  const provenance = ScrollProvenanceV3.safeParse(generated.provenance);
  if (!provenance.success)
    return { kind: 'refused', stage: 'admission', issues: [{ code: 'provenance_refused', path: '$' }] };
  return {
    kind: 'compiled',
    document: stored,
    provenance: JSON.parse(JSON.stringify(provenance.data)) as Record<string, unknown>,
    documentVersion: document.schemaVersion,
    provenanceVersion: SCROLL_PROVENANCE_V3_SCHEMA_VERSION,
    documentSha256: document.integrity.sha256,
    explanationUnitId: document.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOfV3(document),
    ...(generated.notices.length === 0 ? {} : { notices: asIssues(generated.notices) }),
  };
}
