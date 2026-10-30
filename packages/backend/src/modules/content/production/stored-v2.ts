import { validateDocumentV2 } from '@knowscroll/scroll-model';
import type { AuthoredScrollV2 } from '@knowscroll/scroll-model/producer';
import {
  SCROLL_PROVENANCE_V2_SCHEMA_VERSION,
  ScrollProvenanceV2,
  type Claim,
  type Source,
} from '@knowscroll/scroll-model/internal';
import { readingFactsOfV2 } from '../adapters/reading-facts-v2.js';
import type { CompileOutcome } from '../application/ports.js';
import { compileGeneratedScrollV2, WRITER_V2_PROMPT_VERSION, type WriterV2Context } from './writer-v2.js';

/** Who made the Scroll: the writer run and the paid attempts that produced the accepted answer. */
export interface ModelProduction {
  readonly runId: string;
  readonly attemptIds: readonly string[];
  readonly model: string;
}

/** The claims a Scroll cites, each the exact text of its source passage, and the sources they come from. */
function evidenceRecord(
  citations: Readonly<Record<string, readonly string[]>>,
  context: WriterV2Context,
): { readonly claims: Claim[]; readonly sources: Source[] } {
  const cited = new Set(Object.values(citations).flat());
  const passages = context.passages.filter((passage) => cited.has(passage.claimId));
  const claims = passages.map((passage): Claim => ({
    claimId: passage.claimId,
    statement: passage.text,
    quote: passage.text,
    sourceId: passage.pageId,
    truthState: 'documented',
  }));
  const pageIds = new Set(passages.map((passage) => passage.pageId));
  const sources = context.pages
    .filter((page) => pageIds.has(page.id))
    .map((page): Source => ({
      sourceId: page.id,
      title: page.title,
      url: page.url,
      snapshotSha256: page.sha256,
      retrievedAt: page.retrievedAt,
    }));
  return { claims, sources };
}

/**
 * Compiles a v2 writer's accepted answer into what admission stores: the consumer document, the
 * private provenance with the claims each stop, aside and the recap cites, and the reading facts.
 *
 * Refuses (with codes and paths, never text) what the producer refuses, a misconception whose
 * source label no person has reviewed (the library admits only reviewed labels), and a document or
 * provenance that does not hold once written out as the exact stored bytes. Pure and deterministic.
 */
export function storedScrollV2(
  authored: AuthoredScrollV2,
  context: WriterV2Context,
  production: ModelProduction,
): CompileOutcome {
  const generated = compileGeneratedScrollV2(authored, context);
  if (generated.kind === 'refused') return generated;
  if (generated.notices.length > 0)
    return { kind: 'refused', stage: 'library', issues: generated.notices.map(({ code, path }) => ({ code, path })) };
  // The stored bytes are what the reader gets: admit exactly those.
  const stored = JSON.parse(JSON.stringify(generated.document)) as Record<string, unknown>;
  const admitted = validateDocumentV2(stored);
  if (admitted.kind !== 'valid' || admitted.notices.length > 0)
    return { kind: 'refused', stage: 'admission', issues: [{ code: 'admission_refused', path: '$' }] };
  const document = admitted.document;
  const { claims, sources } = evidenceRecord(generated.citations, context);
  const provenance = ScrollProvenanceV2.safeParse({
    schemaVersion: SCROLL_PROVENANCE_V2_SCHEMA_VERSION,
    assetId: document.assetId,
    revision: document.revision,
    documentSha256: document.integrity.sha256,
    claims,
    sources,
    citations: Object.entries(generated.citations).map(([partId, claimIds]) => ({ partId, claimIds })),
    checks: [
      { name: 'authoring', version: 'scroll-authoring.v2', verdict: 'pass', reasonCodes: [] },
      { name: 'document', version: document.limitsVersion, verdict: 'pass', reasonCodes: [] },
    ],
    production: {
      kind: 'model',
      runId: production.runId,
      attemptIds: [...production.attemptIds],
      model: production.model,
      promptVersion: WRITER_V2_PROMPT_VERSION,
    },
  });
  if (!provenance.success)
    return { kind: 'refused', stage: 'admission', issues: [{ code: 'provenance_refused', path: '$' }] };
  return {
    kind: 'compiled',
    document: stored,
    provenance: JSON.parse(JSON.stringify(provenance.data)) as Record<string, unknown>,
    documentVersion: document.schemaVersion,
    provenanceVersion: SCROLL_PROVENANCE_V2_SCHEMA_VERSION,
    documentSha256: document.integrity.sha256,
    explanationUnitId: document.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOfV2(document),
  };
}
