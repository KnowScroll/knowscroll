import { z } from 'zod';
import { LanguageTag, OpaqueId } from '@knowscroll/scroll-model';
import { Claim, Source } from '@knowscroll/scroll-model/internal';
import { compileEditorialV3 } from '@knowscroll/scroll-model/producer';
import type { AdmissionIssue, CompileOutcome, SourceParse } from '../application/ports.js';
import { readingFactsOfV3 } from './reading-facts-v3.js';

/**
 * The editorial source of a document v3 (#759): a hand-written `scroll-document.v3` with its passages, as a file. Its
 * own version, apart from `editorial-scroll.v1`, which carries a v1 draft. A new shape gets a new version.
 */
export const EDITORIAL_SOURCE_V3_VERSION = 'editorial-scroll-v3.v1';

/**
 * A hand-written document v3 as a file: the asset it is, the library recipe whose topic and facets it covers, its
 * explanation unit, its passages, and the authored Scroll (`scroll-authoring.v3`). The revision number is not in the
 * file: admission assigns it. The production record is set by code from `reference`, so an authored Scroll can never
 * claim to be model-written.
 */
const EditorialSourceV3Schema = z.strictObject({
  schemaVersion: z.literal(EDITORIAL_SOURCE_V3_VERSION),
  /** The asset's identity in the inventory (`content.assets.id`) and in the document. */
  assetId: z.uuid(),
  /** A stable name of the authored piece, kept in the production record. */
  reference: OpaqueId,
  /** The library recipe (`LibraryRecipe.key`) whose topic and facets this Scroll covers; coverage reads it. */
  recipe: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
  explanationUnitId: OpaqueId,
  language: LanguageTag,
  claims: z.array(Claim).min(1).max(48),
  sources: z.array(Source).min(1).max(24),
  /** The `scroll-authoring.v3` object; validated in stages by scroll-model's compile. */
  scroll: z.unknown(),
});

function issuesOf(error: z.ZodError): AdmissionIssue[] {
  const issues = error.issues
    .slice(0, 32)
    .map((issue) => ({ code: issue.code, path: issue.path.map(String).join('.') }));
  return issues.length === 0 ? [{ code: 'invalid', path: '$' }] : issues;
}

/** Parses a document v3 source file's envelope. Reports stable codes and paths only, never the file's text (D-017). */
export function parseEditorialSourceV3(raw: unknown): SourceParse {
  const parsed = EditorialSourceV3Schema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: issuesOf(parsed.error) };
  return { kind: 'source', assetId: parsed.data.assetId, source: parsed.data };
}

/**
 * Compiles a document v3 source as revision `revision` through scroll-model's editorial compile: the evidence rules on
 * the authored form (every figure and quotation in a passage its part cites, no copying), code-set ids, measures and
 * hash, and `validateDocumentV3` on exactly the bytes that will be stored. Pure: the same source and revision give
 * byte-identical output, which is what makes a repeated import a no-op.
 */
export function compileEditorialSourceV3(source: unknown, revision: number): CompileOutcome {
  const parsed = EditorialSourceV3Schema.safeParse(source);
  if (!parsed.success) return { kind: 'refused', stage: 'source', issues: issuesOf(parsed.error) };
  const editorial = parsed.data;
  const compiled = compileEditorialV3({
    authored: editorial.scroll,
    publication: {
      assetId: editorial.assetId,
      revision,
      language: editorial.language,
      explanationUnitId: editorial.explanationUnitId,
    },
    claims: editorial.claims,
    sources: editorial.sources,
    production: { kind: 'authored-editorial', reference: editorial.reference },
  });
  if (compiled.kind === 'refused')
    return {
      kind: 'refused',
      stage: compiled.stage,
      issues: compiled.issues.slice(0, 32).map((issue) => ({ code: issue.code, path: issue.path })),
    };
  const { document, provenance } = compiled;
  return {
    kind: 'compiled',
    document: JSON.parse(JSON.stringify(document)) as { readonly [key: string]: unknown },
    provenance: JSON.parse(JSON.stringify(provenance)) as { readonly [key: string]: unknown },
    documentVersion: document.schemaVersion,
    provenanceVersion: provenance.schemaVersion,
    documentSha256: document.integrity.sha256,
    explanationUnitId: document.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOfV3(document),
  };
}
