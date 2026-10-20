import { z } from 'zod';
import { OpaqueId, WORDS_PER_MINUTE, admitDocument, walkBlocks } from '@knowscroll/scroll-model';
import { DraftProvenance, compileDraft } from '@knowscroll/scroll-model/producer';
import { READING_FACTS_VERSION, type ReadingFacts } from '../domain/reading-facts.js';
import { ReadingFactsSchema } from './reading-facts-schema.js';
import type { AdmissionIssue, CompileOutcome, SourceParse } from '../application/ports.js';

/** The editorial source file's version. A new shape gets a new version; this release reads only this one. */
export const EDITORIAL_SOURCE_VERSION = 'editorial-scroll.v1';

/**
 * An authored editorial Scroll as a file (D-005): what the editorial team decides, in scroll-model's
 * producer form. The revision number is not in the file: admission assigns it (a changed file is a
 * new revision, the same file is the same one). The provenance's production record is set by code
 * from `reference`, so an authored Scroll can never claim to be model-written.
 */
const EditorialSourceSchema = z.strictObject({
  schemaVersion: z.literal(EDITORIAL_SOURCE_VERSION),
  /** The asset's identity in the inventory (`content.assets.id`) and in the document. */
  assetId: z.uuid(),
  /** A stable name of the authored piece, kept in the production record. */
  reference: OpaqueId,
  publication: DraftProvenance.shape.publication.omit({ assetId: true, revision: true }),
  claims: DraftProvenance.shape.claims,
  sources: DraftProvenance.shape.sources,
  material: DraftProvenance.shape.material,
  /** The `scroll-draft.v1` object; validated in stages by scroll-model's compile. */
  draft: z.unknown(),
});

type EditorialSource = z.infer<typeof EditorialSourceSchema>;

function issuesOf(error: z.ZodError): AdmissionIssue[] {
  const issues = error.issues
    .slice(0, 32)
    .map((issue) => ({ code: issue.code, path: issue.path.map(String).join('.') }));
  return issues.length === 0 ? [{ code: 'invalid', path: '$' }] : issues;
}

/**
 * Parses an editorial source file's envelope. Reports stable codes and paths only; never the file's
 * text (diagnostics carry no free text, D-017).
 */
export function parseEditorialSource(raw: unknown): SourceParse {
  const parsed = EditorialSourceSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid', issues: issuesOf(parsed.error) };
  return { kind: 'source', assetId: parsed.data.assetId, source: parsed.data };
}

/** Block weights, nested owners and the reading estimate of a document, from its code-set measures. */
export function readingFactsOf(document: {
  readonly measures: {
    readonly version: string;
    readonly totalWeight: number;
    readonly blocks: readonly { readonly blockId: string; readonly weight: number }[];
  };
  readonly sections: Parameters<typeof walkBlocks>[0];
}): ReadingFacts {
  const nested: { id: string; owner: string; type: string }[] = [];
  const types = new Map<string, string>();
  for (const visit of walkBlocks(document.sections)) {
    types.set(visit.block.id, visit.block.type);
    if (visit.parent !== null) nested.push({ id: visit.block.id, owner: visit.parent.id, type: visit.block.type });
  }
  return ReadingFactsSchema.parse({
    v: READING_FACTS_VERSION,
    measuresVersion: document.measures.version,
    totalWeight: document.measures.totalWeight,
    estimatedReadingMs: Math.round((document.measures.totalWeight / WORDS_PER_MINUTE) * 60_000),
    blocks: document.measures.blocks.map((block) => ({
      id: block.blockId,
      weight: block.weight,
      type: types.get(block.blockId),
    })),
    nested,
  });
}

/**
 * Compiles and admits an editorial source as revision `revision`, through scroll-model's admission
 * path: `compileDraft` (staged draft checks, the honesty rules, the copy check, code-set measures,
 * the integrity hash and a stored-revision validation), then `admitDocument` on exactly the bytes
 * that will be stored (a JSON round trip of the compiled document). Pure: the same source and
 * revision give byte-identical output, which is what makes a repeated import a no-op.
 */
export function compileEditorialSource(source: unknown, revision: number): CompileOutcome {
  const parsed = EditorialSourceSchema.safeParse(source);
  if (!parsed.success) return { kind: 'refused', stage: 'source', issues: issuesOf(parsed.error) };
  const editorial: EditorialSource = parsed.data;
  const provenanceInput: DraftProvenance = {
    schemaVersion: 'scroll-draft-provenance.v1',
    publication: { ...editorial.publication, assetId: editorial.assetId, revision },
    claims: editorial.claims,
    sources: editorial.sources,
    material: editorial.material,
    offeredMedia: [],
    production: { kind: 'authored-editorial', reference: editorial.reference },
  };
  const compiled = compileDraft(editorial.draft, provenanceInput);
  if (compiled.kind === 'refused') {
    return {
      kind: 'refused',
      stage: compiled.stage,
      issues: compiled.issues.slice(0, 32).map((issue) => ({ code: issue.code, path: issue.path })),
    };
  }
  const stored = JSON.parse(JSON.stringify(compiled.document)) as unknown;
  const admitted = admitDocument(stored);
  if (admitted.kind !== 'valid') {
    return {
      kind: 'refused',
      stage: 'admit',
      issues:
        admitted.kind === 'invalid'
          ? admitted.issues.slice(0, 32).map((issue) => ({ code: issue.code, path: issue.path }))
          : [{ code: 'unsupported_version', path: 'schemaVersion' }],
    };
  }
  const document = admitted.document;
  return {
    kind: 'compiled',
    document: stored as { readonly [key: string]: unknown },
    provenance: JSON.parse(JSON.stringify(compiled.internalProvenance)) as { readonly [key: string]: unknown },
    documentVersion: document.schemaVersion,
    provenanceVersion: compiled.internalProvenance.schemaVersion,
    documentSha256: document.integrity.sha256,
    explanationUnitId: document.explanationUnitId,
    language: document.language,
    title: document.title,
    readingFacts: readingFactsOf(document),
  };
}
