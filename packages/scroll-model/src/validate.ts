import { Block, BLOCK_VERSIONS, isBlockType, type AnyBlock } from './blocks/catalog.js';
import { BlockA11y, FallbackText } from './blocks/envelope.js';
import { canonicalJson, canonicalSha256, canonicalSize, nestsDeeperThan, utf8ByteLength } from './canonical.js';
import {
  INTEGRITY_METHOD,
  SCROLL_DOCUMENT_SCHEMA_VERSION,
  ScrollDocument,
  walkBlocks,
  type Section,
} from './document.js';
import { fallbackBlockFor } from './fallback.js';
import { issueFromSchema, uniqueIssues, type Issue, type ReasonCode } from './issues.js';
import { FIELD_LIMITS, LIMITS } from './limits.js';
import { computeMeasures } from './measures.js';
import { LocalId } from './primitives.js';
import { BASELINE_TYPES, deriveGesture, fallbackTextOf, isInteractiveBlock, visibleTexts } from './registry.js';
import { simulationIssues } from './simulation/checks.js';

/**
 * Validation of stored documents and client renditions (`scroll-checks.v1`). Every outcome is
 * typed; nothing throws on bad input.
 */

export type DocumentOutcome =
  | { readonly kind: 'valid'; readonly document: ScrollDocument }
  /** The envelope is not scroll-document.v1 (a newer or unknown schema, or none). */
  | { readonly kind: 'unsupported-version'; readonly schemaVersion: string | null }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] };

export interface ValidateOptions {
  /**
   * `stored` (default): a published revision; measures and integrity must match, and no
   * `fallback` block or `rendition` member may appear. `rendition`: the output of `negotiate` for
   * one client; when it substituted blocks it carries `rendition`, whose hash must match.
   */
  readonly purpose?: 'stored' | 'rendition';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** SHA-256 of the canonical JSON of the document without its `integrity` and `rendition` members. */
export function computeIntegrity(
  document: Omit<ScrollDocument, 'integrity' | 'rendition'> & { integrity?: unknown; rendition?: unknown },
): string {
  return canonicalSha256({ ...document, integrity: undefined, rendition: undefined });
}

/** Bytes a `rendition` member adds to a document (fixed: two SHA-256 digests and the method). */
export const RENDITION_MEMBER_BYTES = utf8ByteLength(
  `,"rendition":${canonicalJson({ method: INTEGRITY_METHOD, of: '0'.repeat(64), sha256: '0'.repeat(64) })}`,
);

/** Unknown block types and versions, found before schema parsing so they get their own codes. */
function unknownBlockIssues(input: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const check = (block: unknown, path: string) => {
    if (!isRecord(block)) return;
    const { type, version } = block;
    if (typeof type !== 'string') return;
    if (!isBlockType(type)) issues.push({ code: 'block_type_unknown', path: `${path}.type` });
    else if (version !== BLOCK_VERSIONS[type]) issues.push({ code: 'block_version_unknown', path: `${path}.version` });
  };
  const sections = input['sections'];
  if (!Array.isArray(sections)) return issues;
  sections.forEach((section: unknown, sectionIndex) => {
    if (!isRecord(section) || !Array.isArray(section['blocks'])) return;
    (section['blocks'] as unknown[]).forEach((block, blockIndex) => {
      const path = `sections.${sectionIndex}.blocks.${blockIndex}`;
      check(block, path);
      if (isRecord(block) && block['type'] === 'disclosure' && isRecord(block['data'])) {
        const children = block['data']['blocks'];
        if (Array.isArray(children))
          children.forEach((child: unknown, index) => check(child, `${path}.data.blocks.${index}`));
      }
    });
  });
  return issues;
}

/**
 * Checks of one block that need no document context. `evaluate: false` skips the full-grid
 * evaluation of simulations (used once a document has already failed a limit).
 */
export function blockIssues(block: AnyBlock, path: string, options: { evaluate?: boolean } = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (code: ReasonCode, at = path) => issues.push({ code, path: at });
  if (block.gesture !== deriveGesture(block)) add('gesture_mismatch', `${path}.gesture`);
  if ('fallbackText' in block && block.type !== 'fallback') {
    if (block.fallbackText.length < FIELD_LIMITS.fallbackTextMinChars)
      add('fallback_text_too_short', `${path}.fallbackText`);
  }
  const data = `${path}.data`;
  switch (block.type) {
    case 'quote':
      if (block.data.kind === 'pull' && block.data.attribution !== undefined) add('quote_attribution_unexpected', data);
      break;
    case 'code': {
      const lines = block.data.code.split('\n');
      if (lines.length > FIELD_LIMITS.codeLines) add('code_too_many_lines', data);
      if (lines.some((line) => line.length > FIELD_LIMITS.codeLineChars)) add('code_line_too_long', data);
      if ((block.data.highlightLines ?? []).some((line) => line > lines.length))
        add('code_highlight_out_of_range', data);
      break;
    }
    case 'table':
      if (block.data.rows.some((row) => row.length !== block.data.columns.length)) add('table_shape', data);
      break;
    case 'media':
      if (block.data.kind === 'video' && block.data.poster === undefined) add('media_poster_missing', data);
      if (block.data.kind === 'video' && block.data.captions === undefined) add('media_captions_missing', data);
      if (block.data.kind === 'audio' && block.data.poster !== undefined) add('media_poster_unexpected', data);
      break;
    case 'timeline':
      if (new Set(block.data.events.map((event) => event.id)).size !== block.data.events.length)
        add('id_duplicate', data);
      break;
    case 'sequence':
      if (new Set(block.data.steps.map((step) => step.id)).size !== block.data.steps.length) add('id_duplicate', data);
      break;
    case 'diagram':
      issues.push(...diagramIssues(block, data));
      break;
    case 'chart':
      issues.push(...chartIssues(block, data));
      break;
    case 'simulation':
      if (options.evaluate !== false) issues.push(...simulationIssues(block.data, data));
      break;
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'callout':
    case 'disclosure':
    case 'figure':
    case 'comparison':
    case 'fallback':
      break;
  }
  return issues;
}

function diagramIssues(block: Extract<AnyBlock, { type: 'diagram' }>, path: string): Issue[] {
  const codes = new Set<ReasonCode>();
  const { nodes, edges, groups, frames, interaction, layout } = block.data;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const frameIds = new Set(frames.map((frame) => frame.id));
  const groupIds = new Set(groups.map((group) => group.id));
  const all = [...nodes, ...edges, ...groups, ...frames].map((item) => item.id);
  if (new Set(all).size !== all.length) codes.add('id_duplicate');
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) codes.add('diagram_reference_unknown');
    if (edge.from === edge.to) codes.add('diagram_edge_self');
  }
  if (nodes.some((node) => node.group !== undefined && !groupIds.has(node.group)))
    codes.add('diagram_reference_unknown');
  for (const frame of frames) {
    const known = (id: string) => nodeIds.has(id) || edgeIds.has(id);
    if (!frame.emphasis.every(known) || !frame.hidden.every(known)) codes.add('diagram_reference_unknown');
    if (frame.weights.some((weight) => !edgeIds.has(weight.edge))) codes.add('diagram_reference_unknown');
    if (new Set(frame.weights.map((weight) => weight.edge)).size !== frame.weights.length) codes.add('id_duplicate');
  }
  switch (interaction.kind) {
    case 'static':
      if (frames.length > 0) codes.add('diagram_frames_unexpected');
      break;
    case 'steps':
    case 'toggle':
      if (frames.length < 2) codes.add('diagram_frames_missing');
      break;
    case 'drag-to-target': {
      if (frames.length < 2) codes.add('diagram_frames_missing');
      const token = nodes.find((node) => node.id === interaction.token);
      if (token === undefined || token.kind !== 'token') codes.add('diagram_token_invalid');
      const targetNodes = interaction.targets.map((target) => target.node);
      if (
        new Set(targetNodes).size !== targetNodes.length ||
        interaction.targets.some(
          (target) => !nodeIds.has(target.node) || target.node === interaction.token || !frameIds.has(target.frame),
        ) ||
        !frameIds.has(interaction.initialFrame)
      ) {
        codes.add('diagram_target_invalid');
      }
      break;
    }
  }
  const cells = nodes.map((node) => (node.cell === undefined ? null : `${node.cell.column},${node.cell.row}`));
  if (layout === 'grid') {
    if (cells.includes(null) || new Set(cells).size !== cells.length) codes.add('diagram_cells_invalid');
  } else if (cells.some((cell) => cell !== null)) codes.add('diagram_cells_invalid');
  return [...codes].map((code) => ({ code, path }));
}

function chartIssues(block: Extract<AnyBlock, { type: 'chart' }>, path: string): Issue[] {
  const codes = new Set<ReasonCode>();
  const spec = block.data.spec;
  const checkAxis = (
    axis: { scale: 'linear' | 'log'; domain?: readonly [number, number] | undefined },
    values: readonly number[],
  ) => {
    if (axis.domain !== undefined) {
      const [low, high] = axis.domain;
      if (!(low < high) || values.some((value) => value < low || value > high)) codes.add('chart_domain');
    }
    if (
      axis.scale === 'log' &&
      (values.some((value) => value <= 0) || (axis.domain !== undefined && axis.domain[0] <= 0))
    ) {
      codes.add('chart_log_scale');
    }
  };
  switch (spec.kind) {
    case 'bar': {
      if (spec.series.some((series) => series.values.length !== spec.categories.length)) codes.add('chart_shape');
      if (new Set(spec.series.map((series) => series.id)).size !== spec.series.length) codes.add('id_duplicate');
      if (spec.categories.length * spec.series.length > LIMITS.chartPoints) codes.add('chart_too_many_points');
      checkAxis(
        spec.valueAxis,
        spec.series.flatMap((series) => series.values),
      );
      break;
    }
    case 'line':
    case 'scatter': {
      const points = spec.series.flatMap((series) => series.points);
      if (points.length > LIMITS.chartPoints) codes.add('chart_too_many_points');
      if (new Set(spec.series.map((series) => series.id)).size !== spec.series.length) codes.add('id_duplicate');
      checkAxis(
        spec.x,
        points.map((point) => point[0]),
      );
      checkAxis(
        spec.y,
        points.map((point) => point[1]),
      );
      break;
    }
    case 'heatmap': {
      if (
        spec.values.length !== spec.rows.length ||
        spec.values.some((row) => row.length !== spec.columns.length) ||
        (spec.highlightRow !== undefined && spec.highlightRow >= spec.rows.length)
      ) {
        codes.add('chart_shape');
      }
      if (spec.rows.length * spec.columns.length > LIMITS.chartPoints) codes.add('chart_too_many_points');
      const values = spec.values.flat();
      if (
        !(spec.scale.min < spec.scale.max) ||
        values.some((value) => value < spec.scale.min || value > spec.scale.max)
      ) {
        codes.add('chart_domain');
      }
      break;
    }
  }
  return [...codes].map((code) => ({ code, path }));
}

interface DocumentLike {
  readonly kicker: string;
  readonly title: string;
  readonly dek: string;
  readonly sections: readonly Section[];
}

const BASELINE: ReadonlySet<string> = new Set(BASELINE_TYPES);

/**
 * Visible characters of a block in the worst rendition: a block a client may lack (anything but
 * the baseline paragraph, subheading and fallback) can be shown as its fallback text instead, and
 * a disclosure as its own fallback or with any of its children substituted.
 */
export function worstVisibleChars(block: AnyBlock): number {
  const own = visibleTexts(block).reduce((total, text) => total + text.length, 0);
  if (BASELINE.has(block.type)) return own;
  const fallback = fallbackTextOf(block).length;
  if (block.type === 'disclosure') {
    const open = own + block.data.blocks.reduce((total, child) => total + worstVisibleChars(child), 0);
    return Math.max(fallback, open);
  }
  return Math.max(fallback, own);
}

/** Bytes a block can add to a document when a rendition substitutes it (or, for a disclosure, its children). */
export function worstGrowthBytes(block: AnyBlock): number {
  if (BASELINE.has(block.type)) return 0;
  const substituted = canonicalSize(fallbackBlockFor(block)) - canonicalSize(block);
  if (block.type !== 'disclosure') return Math.max(0, substituted);
  const children = block.data.blocks.reduce((total, child) => total + worstGrowthBytes(child), 0);
  return Math.max(0, substituted, children);
}

/**
 * Document-wide structure and limits, then every block's own checks. Limits are counted first and
 * cheaply; when one fails, simulations are not evaluated. The visible-text limit holds for the
 * worst rendition a client can be given, so `negotiate` never produces an invalid document.
 */
export function documentIssues(document: DocumentLike): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const claim = (id: string, path: string) => {
    if (ids.has(id)) issues.push({ code: 'id_duplicate', path });
    ids.add(id);
  };
  let visibleChars = document.kicker.length + document.title.length + document.dek.length;
  document.sections.forEach((section, index) => {
    claim(section.id, `sections.${index}.id`);
    if (index > 0 && section.heading === null)
      issues.push({ code: 'heading_missing', path: `sections.${index}.heading` });
    visibleChars += section.heading?.length ?? 0;
    for (const block of section.blocks) visibleChars += worstVisibleChars(block);
  });
  let blocks = 0;
  let interactive = 0;
  let params = 0;
  let media = 0;
  for (const { block, path } of walkBlocks(document.sections)) {
    blocks += 1;
    claim(block.id, `${path}.id`);
    if (isInteractiveBlock(block)) interactive += 1;
    if (block.type === 'simulation') params += block.data.params.length;
    if (block.type === 'figure' || block.type === 'media') media += 1;
  }
  const limits: Issue[] = [];
  if (blocks > LIMITS.blocks) limits.push({ code: 'too_many_blocks', path: '$' });
  if (interactive > LIMITS.interactiveBlocks) limits.push({ code: 'too_many_interactive', path: '$' });
  if (params > LIMITS.paramsTotal) limits.push({ code: 'too_many_params', path: '$' });
  if (media > LIMITS.mediaBlocks) limits.push({ code: 'too_many_media', path: '$' });
  if (visibleChars > LIMITS.visibleChars) limits.push({ code: 'visible_text_too_long', path: '$' });
  const evaluate = limits.length === 0;
  for (const { block, path } of walkBlocks(document.sections)) issues.push(...blockIssues(block, path, { evaluate }));
  return [...limits, ...issues];
}

/**
 * Validates an untrusted value as a scroll-document.v1 revision (or a client rendition of one).
 * Order, cheapest first: shape of the envelope, nesting depth, canonical byte size, unknown block
 * types, the schema, counted limits, then per-block checks (simulations last, and only when every
 * limit holds).
 */
export function validateDocument(input: unknown, options: ValidateOptions = {}): DocumentOutcome {
  if (!isRecord(input)) return { kind: 'invalid', issues: [{ code: 'document_not_object', path: '$' }] };
  const version = input['schemaVersion'];
  if (version !== SCROLL_DOCUMENT_SCHEMA_VERSION) {
    return { kind: 'unsupported-version', schemaVersion: typeof version === 'string' ? version : null };
  }
  if (nestsDeeperThan(input, FIELD_LIMITS.jsonDepth))
    return { kind: 'invalid', issues: [{ code: 'document_too_deep', path: '$' }] };
  let size: number;
  try {
    size = canonicalSize(input);
  } catch {
    return { kind: 'invalid', issues: [{ code: 'document_not_object', path: '$' }] };
  }
  if (size > LIMITS.documentBytes) return { kind: 'invalid', issues: [{ code: 'document_too_large', path: '$' }] };
  const unknown = unknownBlockIssues(input);
  if (unknown.length > 0) return { kind: 'invalid', issues: unknown };
  const parsed = ScrollDocument.safeParse(input);
  if (!parsed.success) return { kind: 'invalid', issues: uniqueIssues(parsed.error.issues.map(issueFromSchema)) };
  const document = parsed.data;
  const issues = documentIssues(document);
  const rendition = document.rendition;
  if ((options.purpose ?? 'stored') === 'stored' || rendition === undefined) {
    if (rendition !== undefined) issues.push({ code: 'rendition_in_stored_document', path: 'rendition' });
    for (const visit of walkBlocks(document.sections)) {
      if (visit.block.type === 'fallback') issues.push({ code: 'fallback_in_stored_document', path: visit.path });
    }
    if (issues.length === 0) {
      if (canonicalJson(computeMeasures(document.sections)) !== canonicalJson(document.measures)) {
        issues.push({ code: 'measures_mismatch', path: 'measures' });
      }
      if (document.integrity.method !== INTEGRITY_METHOD || computeIntegrity(document) !== document.integrity.sha256) {
        issues.push({ code: 'integrity_mismatch', path: 'integrity' });
      }
    }
  } else if (rendition.of !== document.integrity.sha256 || computeIntegrity(document) !== rendition.sha256) {
    issues.push({ code: 'rendition_integrity_mismatch', path: 'rendition' });
  }
  const growth = document.sections.reduce(
    (total, section) => total + section.blocks.reduce((sum, block) => sum + worstGrowthBytes(block), 0),
    rendition === undefined ? RENDITION_MEMBER_BYTES : 0,
  );
  if (size + growth > LIMITS.documentBytes) issues.push({ code: 'document_too_large', path: '$' });
  return issues.length === 0 ? { kind: 'valid', document } : { kind: 'invalid', issues: uniqueIssues(issues) };
}

/** What a renderer can still use from a block it cannot render. */
export interface BlockEnvelopeView {
  readonly id: string | null;
  readonly type: string | null;
  readonly version: number | null;
  readonly fallbackText: string | null;
  readonly a11yLabel: string | null;
  readonly essential: boolean;
}

export type BlockOutcome =
  | { readonly kind: 'block'; readonly block: Block }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'unknown-type' | 'unknown-version';
      readonly envelope: BlockEnvelopeView;
    }
  | { readonly kind: 'invalid'; readonly envelope: BlockEnvelopeView; readonly issues: readonly Issue[] };

/** Reads the envelope fields that are themselves valid, ignoring everything else. */
export function readEnvelope(input: unknown): BlockEnvelopeView {
  if (!isRecord(input))
    return { id: null, type: null, version: null, fallbackText: null, a11yLabel: null, essential: false };
  const id = LocalId.safeParse(input['id']);
  const fallbackText = FallbackText.safeParse(input['fallbackText']);
  const a11y = BlockA11y.safeParse(input['a11y']);
  const type = input['type'];
  const version = input['version'];
  return {
    id: id.success ? id.data : null,
    type: typeof type === 'string' ? type : null,
    version: typeof version === 'number' && Number.isInteger(version) ? version : null,
    fallbackText: fallbackText.success ? fallbackText.data : null,
    a11yLabel: a11y.success ? a11y.data.label : null,
    essential: input['essential'] === true,
  };
}

/**
 * Defensive parse of one block for a renderer: the renderer shows the block, or its fallback text
 * (with a diagnostic) when the type or version is unknown or the data is invalid. The rest of the
 * article still renders.
 */
export function parseBlock(input: unknown): BlockOutcome {
  const envelope = readEnvelope(input);
  if (nestsDeeperThan(input, FIELD_LIMITS.jsonDepth))
    return { kind: 'invalid', envelope, issues: [{ code: 'document_too_deep', path: '$' }] };
  if (envelope.type !== null && !isBlockType(envelope.type))
    return { kind: 'unsupported', reason: 'unknown-type', envelope };
  if (envelope.type !== null && isBlockType(envelope.type) && envelope.version !== BLOCK_VERSIONS[envelope.type]) {
    return { kind: 'unsupported', reason: 'unknown-version', envelope };
  }
  const parsed = Block.safeParse(input);
  if (!parsed.success)
    return { kind: 'invalid', envelope, issues: uniqueIssues(parsed.error.issues.map(issueFromSchema)) };
  const block = parsed.data;
  const issues = blockIssues(block, '$');
  if (block.type === 'disclosure') {
    block.data.blocks.forEach((child, index) => issues.push(...blockIssues(child, `data.blocks.${index}`)));
  }
  return issues.length === 0 ? { kind: 'block', block } : { kind: 'invalid', envelope, issues: uniqueIssues(issues) };
}
