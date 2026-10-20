import { BLOCK_VERSIONS, isBlockType, type AnyBlock } from '../blocks/catalog.js';
import type { BlockA11y } from '../blocks/envelope.js';
import { ILLUSTRATIVE_NOTICE } from '../blocks/simulation.js';
import { canonicalSize, nestsDeeperThan } from '../canonical.js';
import {
  INTEGRITY_METHOD,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  walkBlocks,
  type ScrollDocument,
  type Section,
} from '../document.js';
import { addressedTexts, honestyIssues, type HonestyDocument } from '../internal/honesty.js';
import { ScrollProvenance, SCROLL_PROVENANCE_SCHEMA_VERSION, type ProvenanceBinding } from '../internal/provenance.js';
import { issueFromSchema, uniqueIssues, type Issue } from '../issues.js';
import { FIELD_LIMITS, SCROLL_LIMITS_VERSION } from '../limits.js';
import { computeMeasures } from '../measures.js';
import {
  deriveGesture,
  deriveTextLabel,
  isTextBlockType,
  projectText,
  textFields,
  type TextBlockType,
} from '../registry.js';
import { simulationNumbers } from '../simulation/numbers.js';
import { wordShingles } from '../text.js';
import { computeIntegrity, documentIssues, validateDocument } from '../validate.js';
import { DraftProvenance, ScrollDraft, SCROLL_DRAFT_VERSION, type DraftBlock, type DraftNestedBlock } from './draft.js';
import { canonicaliseBlockText, normaliseDraftInput } from './normalise.js';
import { DRAFT_STAGES, stageOf, type DraftStage } from './reasons.js';

/** The checks version recorded in provenance for every stage that ran. */
export const SCROLL_CHECKS_VERSION = 'scroll-checks.v1';
/** Largest model reply (as canonical JSON) the producer accepts. */
export const DRAFT_MAX_BYTES = 262_144;
/** The copy check refuses a run of more than eight consecutive words shared with the material (D-013). */
export const COPY_RUN_WORDS = 9;

export type DraftOutcome =
  | { readonly kind: 'valid'; readonly draft: ScrollDraft }
  | { readonly kind: 'refused'; readonly stage: DraftStage; readonly issues: readonly Issue[] };

export type CompileOutcome =
  | { readonly kind: 'compiled'; readonly document: ScrollDocument; readonly internalProvenance: ScrollProvenance }
  | { readonly kind: 'refused'; readonly stage: DraftStage; readonly issues: readonly Issue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refused(
  stage: DraftStage,
  issues: readonly Issue[],
): { kind: 'refused'; stage: DraftStage; issues: readonly Issue[] } {
  return { kind: 'refused', stage, issues: uniqueIssues(issues) };
}

/**
 * Stage 0: one JSON object, nested at most `FIELD_LIMITS.jsonDepth` deep, of bounded size, the
 * right version, no reserved or unknown block types. Cheapest checks first.
 */
function envelopeIssues(raw: unknown): Issue[] {
  if (!isRecord(raw)) return [{ code: 'draft_not_object', path: '$' }];
  if (nestsDeeperThan(raw, FIELD_LIMITS.jsonDepth)) return [{ code: 'draft_too_deep', path: '$' }];
  let size: number;
  try {
    size = canonicalSize(raw);
  } catch {
    return [{ code: 'draft_not_object', path: '$' }];
  }
  if (size > DRAFT_MAX_BYTES) return [{ code: 'draft_too_large', path: '$' }];
  const issues: Issue[] = [];
  if (raw['draftVersion'] !== SCROLL_DRAFT_VERSION)
    issues.push({ code: 'draft_version_unknown', path: 'draftVersion' });
  const check = (block: unknown, path: string) => {
    if (!isRecord(block) || typeof block['type'] !== 'string') return;
    const type = block['type'];
    if (type === 'fallback') issues.push({ code: 'fallback_reserved', path: `${path}.type` });
    else if (!isBlockType(type)) issues.push({ code: 'block_type_unknown', path: `${path}.type` });
    if (type === 'disclosure' && isRecord(block['data']) && Array.isArray(block['data']['blocks'])) {
      (block['data']['blocks'] as unknown[]).forEach((child, index) => check(child, `${path}.data.blocks.${index}`));
    }
  };
  const sections = raw['sections'];
  if (Array.isArray(sections)) {
    sections.forEach((section: unknown, sectionIndex) => {
      if (isRecord(section) && Array.isArray(section['blocks'])) {
        (section['blocks'] as unknown[]).forEach((block, index) =>
          check(block, `sections.${sectionIndex}.blocks.${index}`),
        );
      }
    });
  }
  return issues;
}

/** Placeholders that let structure checks run while a missing envelope field is reported. */
const MISSING_A11Y: BlockA11y = { label: 'missing' };
const MISSING_FALLBACK = 'missing'.padEnd(FIELD_LIMITS.fallbackTextMinChars, '.');

interface Assembly {
  readonly sections: Section[];
  readonly issues: Issue[];
}

type TextBlock = Extract<AnyBlock, { type: TextBlockType }>;

/**
 * Turns a parsed draft into document sections: assigns missing ids (`<type>-<n>`, `section-<n>`,
 * skipping ids already used), sets versions and gestures, gives text blocks their derived
 * accessibility label (their fallback text is derived when needed, never stored), turns a
 * simulation's `illustrative: true` into the visible notice, defaults `essential` to false and
 * canonicalises inline text.
 */
function assemble(draft: ScrollDraft): Assembly {
  const issues: Issue[] = [];
  const used = new Set<string>();
  for (const section of draft.sections) {
    if (section.id !== undefined) used.add(section.id);
    for (const block of section.blocks) {
      if (block.id !== undefined) used.add(block.id);
      if (block.type === 'disclosure')
        for (const child of block.data.blocks) if (child.id !== undefined) used.add(child.id);
    }
  }
  const counters = new Map<string, number>();
  const freshId = (prefix: string) => {
    let n = counters.get(prefix) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${prefix}-${n}`;
    } while (used.has(id));
    counters.set(prefix, n);
    used.add(id);
    return id;
  };

  const build = (draftBlock: DraftBlock | DraftNestedBlock, path: string): AnyBlock => {
    const data =
      draftBlock.type === 'disclosure'
        ? {
            ...draftBlock.data,
            blocks: draftBlock.data.blocks.map((child, index) => build(child, `${path}.data.blocks.${index}`)),
          }
        : draftBlock.type === 'simulation'
          ? { ...draftBlock.data, illustrative: draftBlock.data.illustrative ? { notice: ILLUSTRATIVE_NOTICE } : false }
          : draftBlock.data;
    const id = draftBlock.id ?? freshId(draftBlock.type);
    const common = {
      id,
      type: draftBlock.type,
      version: BLOCK_VERSIONS[draftBlock.type],
      essential: draftBlock.essential ?? false,
      gesture: 'none',
      data,
    };
    // The draft schema pairs each type with its data; TypeScript cannot follow that pairing through
    // the spread, so the assembled block is asserted here and checked again by validateDocument.
    let block: AnyBlock;
    if (isTextBlockType(draftBlock.type)) {
      const text = { ...common, a11y: MISSING_A11Y } as TextBlock;
      block = { ...text, a11y: { label: deriveTextLabel(text) } };
    } else {
      const a11y = 'a11y' in draftBlock ? draftBlock.a11y : undefined;
      const fallbackText = 'fallbackText' in draftBlock ? draftBlock.fallbackText : undefined;
      if (a11y === undefined) issues.push({ code: 'a11y_missing', path: `${path}.a11y` });
      if (fallbackText === undefined) issues.push({ code: 'fallback_text_missing', path: `${path}.fallbackText` });
      block = { ...common, a11y: a11y ?? MISSING_A11Y, fallbackText: fallbackText ?? MISSING_FALLBACK } as AnyBlock;
    }
    block = canonicaliseBlockText(block);
    return { ...block, gesture: deriveGesture(block) };
  };

  const sections = draft.sections.map((section, sectionIndex): Section => ({
    id: section.id ?? freshId('section'),
    heading: section.heading,
    blocks: section.blocks.map((block, blockIndex) => build(block, `sections.${sectionIndex}.blocks.${blockIndex}`)),
  }));
  return { sections, issues };
}

/** Finds `anchorText` exactly once in `text`. */
function anchor(
  text: string,
  anchorText: string,
): { start: number; end: number } | 'binding_anchor_not_found' | 'binding_anchor_ambiguous' {
  const start = text.indexOf(anchorText);
  if (start < 0) return 'binding_anchor_not_found';
  if (text.indexOf(anchorText, start + 1) >= 0) return 'binding_anchor_ambiguous';
  return { start, end: start + anchorText.length };
}

/** Resolves draft bindings to provenance bindings (anchor text → UTF-16 range in its field). */
function resolveBindings(
  draft: ScrollDraft,
  document: HonestyDocument,
  provenance: DraftProvenance,
): { bindings: ProvenanceBinding[]; issues: Issue[] } {
  const claims = new Set(provenance.claims.map((claim) => claim.claimId));
  const blocks = new Map<string, AnyBlock>();
  for (const visit of walkBlocks(document.sections)) blocks.set(visit.block.id, visit.block);
  const headings = new Map(document.sections.map((section) => [section.id, section.heading]));
  const bindings: ProvenanceBinding[] = [];
  const issues: Issue[] = [];
  draft.bindings.forEach((binding, index) => {
    const path = `bindings.${index}`;
    if (!claims.has(binding.claimId)) {
      issues.push({ code: 'binding_claim_unknown', path });
      return;
    }
    const located = (
      text: string,
      anchorText: string,
      make: (range: { start: number; end: number }) => ProvenanceBinding,
    ) => {
      const found = anchor(text, anchorText);
      if (typeof found === 'string') issues.push({ code: found, path });
      else bindings.push(make(found));
    };
    if (binding.kind === 'header') {
      located(document[binding.field], binding.anchorText, (range) => ({
        kind: 'header',
        claimId: binding.claimId,
        field: binding.field,
        ...range,
      }));
      return;
    }
    if (binding.kind === 'heading') {
      const heading = headings.get(binding.sectionId);
      if (heading === undefined || heading === null) issues.push({ code: 'binding_section_unknown', path });
      else
        located(heading, binding.anchorText, (range) => ({
          kind: 'heading',
          claimId: binding.claimId,
          sectionId: binding.sectionId,
          ...range,
        }));
      return;
    }
    const block = blocks.get(binding.blockId);
    if (block === undefined) {
      issues.push({ code: 'binding_block_unknown', path });
      return;
    }
    switch (binding.kind) {
      case 'block':
        bindings.push({ kind: 'block', claimId: binding.claimId, blockId: binding.blockId });
        return;
      case 'constant':
        if (
          block.type !== 'simulation' ||
          !block.data.constants.some((constant) => constant.key === binding.constantKey)
        ) {
          issues.push({ code: 'binding_constant_unknown', path });
        } else
          bindings.push({
            kind: 'constant',
            claimId: binding.claimId,
            blockId: binding.blockId,
            constantKey: binding.constantKey,
          });
        return;
      case 'value':
        if (
          block.type !== 'simulation' ||
          !simulationNumbers(block.data).some((number) => number.path === binding.path)
        ) {
          issues.push({ code: 'binding_value_unknown', path });
        } else bindings.push({ kind: 'value', claimId: binding.claimId, blockId: binding.blockId, path: binding.path });
        return;
      case 'passage': {
        const field = binding.field ?? (projectText(block) === null ? null : 'text');
        if (field === null) {
          issues.push({ code: 'binding_block_not_text', path });
          return;
        }
        const target = textFields(block).find((candidate) => candidate.field === field && !candidate.code);
        if (target === undefined) {
          issues.push({ code: 'binding_field_unknown', path });
          return;
        }
        located(target.text, binding.anchorText, (range) => ({
          kind: 'passage',
          claimId: binding.claimId,
          blockId: binding.blockId,
          field,
          ...range,
        }));
        return;
      }
    }
  });
  return { bindings, issues };
}

function mediaRefs(block: AnyBlock): Array<{ mediaId: string; revision: number }> {
  switch (block.type) {
    case 'figure':
      return [block.data.media];
    case 'media':
      return [block.data.media, block.data.poster, block.data.captions].filter((ref) => ref !== undefined);
    case 'sequence':
      return block.data.steps.flatMap((step) => (step.figure === undefined ? [] : [step.figure.media]));
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'quote':
    case 'callout':
    case 'disclosure':
    case 'code':
    case 'table':
    case 'comparison':
    case 'timeline':
    case 'diagram':
    case 'chart':
    case 'simulation':
    case 'fallback':
      return [];
  }
}

/**
 * Evidence stage beyond honesty: offered media only, and no run of `COPY_RUN_WORDS` words copied
 * from a claim quote or research excerpt anywhere a reader can see or hear it — the header,
 * headings, prose, captions, labels, accessibility text, fallback text, alt text, transcripts and
 * table cells (D-013). Code bodies are exempt.
 */
function evidenceIssues(document: HonestyDocument, provenance: DraftProvenance): Issue[] {
  const issues: Issue[] = [];
  const offered = new Set(provenance.offeredMedia.map((ref) => `${ref.mediaId}@${ref.revision}`));
  for (const { block, path } of walkBlocks(document.sections)) {
    if (mediaRefs(block).some((ref) => !offered.has(`${ref.mediaId}@${ref.revision}`)))
      issues.push({ code: 'media_not_offered', path });
  }
  const material = new Set<string>();
  for (const text of [...provenance.claims.map((claim) => claim.quote), ...provenance.material]) {
    for (const shingle of wordShingles(text, COPY_RUN_WORDS)) material.add(shingle);
  }
  for (const entry of addressedTexts(document)) {
    if (entry.code) continue;
    if ([...wordShingles(entry.text, COPY_RUN_WORDS)].some((shingle) => material.has(shingle))) {
      issues.push({ code: 'copied_passage', path: entry.path });
    }
  }
  return issues;
}

interface Analysis {
  readonly draft: ScrollDraft;
  readonly provenance: DraftProvenance;
  readonly sections: Section[];
  readonly bindings: ProvenanceBinding[];
}

/** Runs every stage; stops at the first stage with findings. */
function analyse(
  raw: unknown,
  provenanceInput: DraftProvenance,
): Analysis | { kind: 'refused'; stage: DraftStage; issues: readonly Issue[] } {
  const provenanceParse = DraftProvenance.safeParse(provenanceInput);
  if (!provenanceParse.success) {
    return refused(
      'envelope',
      provenanceParse.error.issues.map((issue) => {
        const mapped = issueFromSchema(issue);
        return { code: 'provenance_mismatch', path: `provenance.${mapped.path}` };
      }),
    );
  }
  const provenance = provenanceParse.data;

  const envelope = envelopeIssues(raw);
  if (envelope.length > 0) return refused('envelope', envelope);

  const parsed = ScrollDraft.safeParse(normaliseDraftInput(raw));
  if (!parsed.success) return refused('schema', parsed.error.issues.map(issueFromSchema));
  const draft = parsed.data;

  const assembly = assemble(draft);
  const document: HonestyDocument = {
    kicker: provenance.publication.kicker,
    title: draft.title,
    dek: draft.dek,
    sections: assembly.sections,
  };
  const structural = [...assembly.issues, ...documentIssues(document, { proof: true })];
  const structure = structural.filter((issue) => stageOf(issue.code) !== 'computation');
  if (structure.length > 0) return refused('structure', structure);
  const computation = structural.filter((issue) => stageOf(issue.code) === 'computation');
  if (computation.length > 0) return refused('computation', computation);

  const resolved = resolveBindings(draft, document, provenance);
  const evidence = [
    ...resolved.issues,
    ...honestyIssues(document, { claims: provenance.claims, bindings: resolved.bindings }),
    ...evidenceIssues(document, provenance),
  ];
  if (evidence.length > 0) return refused('evidence', evidence);

  const target = provenance.publication.targetMinutes;
  if (target !== undefined) {
    const minutes = computeMeasures(assembly.sections).readingMinutes;
    if (minutes < target[0] || minutes > target[1])
      return refused('brief', [{ code: 'reading_length_out_of_brief', path: '$' }]);
  }
  return { draft, provenance, sections: assembly.sections, bindings: resolved.bindings };
}

/**
 * Validates a model reply in stages — envelope, schema, structure, computation, evidence, brief —
 * and stops at the first stage with findings. Pure: same reply and provenance, same outcome.
 */
export function validateDraft(raw: unknown, provenance: DraftProvenance): DraftOutcome {
  const analysis = analyse(raw, provenance);
  if ('kind' in analysis) return analysis;
  return { kind: 'valid', draft: analysis.draft };
}

/**
 * Compiles a model reply into the consumer document and its internal provenance. Code, not the
 * model, sets ids that are missing, versions, gestures, text blocks' accessibility label, the
 * illustrative notice, framing, template, theme, series, reading time, coverage weights and the
 * integrity hash. Compiling the same input twice gives byte-identical output; compiling
 * `draftFromDocument` of a compiled document gives the same document again.
 */
export function compileDraft(raw: unknown, provenance: DraftProvenance): CompileOutcome {
  const analysis = analyse(raw, provenance);
  if ('kind' in analysis) return analysis;
  const { draft, sections, bindings } = analysis;
  const publication = analysis.provenance.publication;
  const unsigned: Omit<ScrollDocument, 'integrity'> = {
    schemaVersion: SCROLL_DOCUMENT_SCHEMA_VERSION,
    assetId: publication.assetId,
    revision: publication.revision,
    language: publication.language,
    explanationUnitId: publication.explanationUnitId,
    ...(publication.series === undefined ? {} : { series: publication.series }),
    template: publication.template,
    theme: publication.theme,
    kicker: publication.kicker,
    title: draft.title,
    dek: draft.dek,
    framing: publication.framing,
    sections,
    corrections: publication.corrections,
    limitsVersion: SCROLL_LIMITS_VERSION,
    measures: computeMeasures(sections),
  };
  const candidate: ScrollDocument = {
    ...unsigned,
    integrity: { method: INTEGRITY_METHOD, sha256: computeIntegrity(unsigned) },
  };
  const checked = validateDocument(candidate);
  if (checked.kind !== 'valid') {
    return refused(
      'publish',
      checked.kind === 'invalid' ? checked.issues : [{ code: 'document_not_object', path: '$' }],
    );
  }
  const document = checked.document;

  const boundClaims = new Set(bindings.map((binding) => binding.claimId));
  const claims = analysis.provenance.claims.filter((claim) => boundClaims.has(claim.claimId));
  const sourceIds = new Set(claims.map((claim) => claim.sourceId));
  const internal = ScrollProvenance.safeParse({
    schemaVersion: SCROLL_PROVENANCE_SCHEMA_VERSION,
    assetId: document.assetId,
    revision: document.revision,
    documentSha256: document.integrity.sha256,
    claims,
    sources: analysis.provenance.sources.filter((source) => sourceIds.has(source.sourceId)),
    bindings,
    checks: [...DRAFT_STAGES, 'publish'].map((name) => ({
      name,
      version: SCROLL_CHECKS_VERSION,
      verdict: 'pass',
      reasonCodes: [],
    })),
    production: analysis.provenance.production,
  });
  if (!internal.success || !claimsHaveSources(claims, analysis.provenance)) {
    return refused('publish', [{ code: 'provenance_mismatch', path: 'internalProvenance' }]);
  }
  return { kind: 'compiled', document, internalProvenance: internal.data };
}

function claimsHaveSources(claims: readonly { sourceId: string }[], provenance: DraftProvenance): boolean {
  const sources = new Set(provenance.sources.map((source) => source.sourceId));
  return claims.every((claim) => sources.has(claim.sourceId));
}
