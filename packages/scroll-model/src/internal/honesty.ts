import type { AnyBlock } from '../blocks/catalog.js';
import { isIllustrative } from '../blocks/simulation.js';
import { walkBlocks, type Section } from '../document.js';
import type { Issue } from '../issues.js';
import { textFields } from '../registry.js';
import { simulationNumbers } from '../simulation/numbers.js';
import { numericTokens, sentenceRanges } from '../text.js';
import type { Claim, ProvenanceBinding } from './provenance.js';

/**
 * Honesty checks (`scroll-checks.v1`, evidence stage): pure functions of a document and its
 * provenance. They prove that every number a reader is shown or read is anchored to a claim; they
 * cannot prove that a claim is true or that the prose says what the claim says (that is content
 * review, blueprint §11).
 *
 * 1. **Every numeric token** (`\p{N}`: digits, fractions such as ⅜, superscripts such as ², Roman
 *    numerals; `4,096` and `1.46` are one token) in **every reader-facing text** — title, dek,
 *    kicker, section headings, and every field `textFields` lists (prose, captions, labels, units,
 *    accessibility label and description, fallback text, alt text, transcripts, table cells) — lies
 *    inside an anchor bound to a claim on that same field (`number_unbound`). An anchor never
 *    crosses a sentence boundary (`binding_anchor_crosses_sentence`). The only exemption is the
 *    body of a code block: code is shown, never run, and is not a factual claim.
 * 2. Every chart has at least one claim binding for its data (`numeric_block_unbound`).
 * 3. A simulation not marked illustrative binds every number it states (`simulationNumbers`:
 *    ranges, steps, defaults, constants, literal operands, exponents, lookup breakpoints, band
 *    thresholds) except the structural ones 0, ±1, 2 and 0.5 (`constant_unbound`,
 *    `simulation_number_unbound`), and has at least one binding (`simulation_unbound`). An
 *    illustrative simulation carries the "Illustrative" notice, which the schema requires and the
 *    renderer always shows.
 */

/** Numbers that state the shape of a formula or a range rather than a quantity. */
export const STRUCTURAL_LITERALS: ReadonlySet<number> = new Set([0, 1, -1, 2, 0.5]);

/** The header and sections a binding can point into, and the blocks. */
export interface HonestyDocument {
  readonly title: string;
  readonly dek: string;
  readonly kicker: string;
  readonly sections: readonly Section[];
}

interface HonestyInput {
  readonly claims: readonly Pick<Claim, 'claimId'>[];
  readonly bindings: readonly ProvenanceBinding[];
}

type Anchor = readonly [number, number];

/** Address of a text: `block:<id>:<field>`, `header:<field>` or `heading:<sectionId>`. */
function addressOf(binding: ProvenanceBinding): string | null {
  switch (binding.kind) {
    case 'passage':
      return `block:${binding.blockId}:${binding.field}`;
    case 'header':
      return `header:${binding.field}`;
    case 'heading':
      return `heading:${binding.sectionId}`;
    case 'constant':
    case 'value':
    case 'block':
      return null;
  }
}

interface AddressedText {
  readonly address: string;
  readonly text: string;
  /** Issue path of the text, e.g. `sections.1.blocks.0.data.caption`. */
  readonly path: string;
  readonly code: boolean;
}

/** Every reader-facing text of the document with its binding address. */
export function addressedTexts(document: HonestyDocument): AddressedText[] {
  const texts: AddressedText[] = [
    { address: 'header:title', text: document.title, path: 'title', code: false },
    { address: 'header:dek', text: document.dek, path: 'dek', code: false },
    { address: 'header:kicker', text: document.kicker, path: 'kicker', code: false },
  ];
  document.sections.forEach((section, index) => {
    if (section.heading !== null) {
      texts.push({
        address: `heading:${section.id}`,
        text: section.heading,
        path: `sections.${index}.heading`,
        code: false,
      });
    }
  });
  for (const { block, path } of walkBlocks(document.sections)) {
    for (const field of textFields(block)) {
      texts.push({
        address: `block:${block.id}:${field.field}`,
        text: field.text,
        path: `${path}.${field.field}`,
        code: field.code,
      });
    }
  }
  return texts;
}

function withinOneSentence(text: string, [start, end]: Anchor): boolean {
  return sentenceRanges(text).some(([from, to]) => from <= start && end <= to);
}

/** Binding integrity: claims, blocks, fields, ranges, sentences, constants and value paths must exist. */
export function bindingIssues(document: HonestyDocument, provenance: HonestyInput): Issue[] {
  const issues: Issue[] = [];
  const claims = new Set(provenance.claims.map((claim) => claim.claimId));
  const blocks = new Map<string, AnyBlock>();
  for (const visit of walkBlocks(document.sections)) blocks.set(visit.block.id, visit.block);
  const texts = new Map(addressedTexts(document).map((entry) => [entry.address, entry]));
  provenance.bindings.forEach((binding, index) => {
    const path = `bindings.${index}`;
    if (!claims.has(binding.claimId)) issues.push({ code: 'binding_claim_unknown', path });
    if (binding.kind === 'heading') {
      if (!texts.has(`heading:${binding.sectionId}`)) {
        issues.push({ code: 'binding_section_unknown', path });
        return;
      }
    } else if (binding.kind !== 'header') {
      const block = blocks.get(binding.blockId);
      if (block === undefined) {
        issues.push({ code: 'binding_block_unknown', path });
        return;
      }
      if (binding.kind === 'constant') {
        if (
          block.type !== 'simulation' ||
          !block.data.constants.some((constant) => constant.key === binding.constantKey)
        ) {
          issues.push({ code: 'binding_constant_unknown', path });
        }
        return;
      }
      if (binding.kind === 'value') {
        if (
          block.type !== 'simulation' ||
          !simulationNumbers(block.data).some((number) => number.path === binding.path)
        ) {
          issues.push({ code: 'binding_value_unknown', path });
        }
        return;
      }
      if (binding.kind === 'block') return;
    }
    const address = addressOf(binding);
    const target = address === null ? undefined : texts.get(address);
    if (target === undefined || target.code) {
      issues.push({ code: 'binding_field_unknown', path });
      return;
    }
    if (binding.kind !== 'passage' && binding.kind !== 'header' && binding.kind !== 'heading') return;
    const anchor: Anchor = [binding.start, binding.end];
    if (!(binding.start < binding.end) || binding.end > target.text.length)
      issues.push({ code: 'binding_range_invalid', path });
    else if (!withinOneSentence(target.text, anchor)) issues.push({ code: 'binding_anchor_crosses_sentence', path });
  });
  return issues;
}

/** The honesty rules above, after binding integrity. */
export function honestyIssues(document: HonestyDocument, provenance: HonestyInput): Issue[] {
  const issues = bindingIssues(document, provenance);
  const anchors = new Map<string, Anchor[]>();
  const byBlock = new Map<string, ProvenanceBinding[]>();
  for (const binding of provenance.bindings) {
    const address = addressOf(binding);
    if (address !== null && (binding.kind === 'passage' || binding.kind === 'header' || binding.kind === 'heading')) {
      anchors.set(address, [...(anchors.get(address) ?? []), [binding.start, binding.end]]);
    }
    if (binding.kind !== 'header' && binding.kind !== 'heading') {
      byBlock.set(binding.blockId, [...(byBlock.get(binding.blockId) ?? []), binding]);
    }
  }

  for (const entry of addressedTexts(document)) {
    if (entry.code) continue;
    const covering = (anchors.get(entry.address) ?? []).filter((anchor) => withinOneSentence(entry.text, anchor));
    // A readout template's `{key}` placeholders are keys, not numbers: the values they show are the
    // simulation's own numbers (rule 3).
    const placeholders = entry.address.endsWith(':data.readout.template')
      ? [...entry.text.matchAll(/\{[a-z][a-zA-Z0-9]{0,23}\}/gu)].map(
          (match) => [match.index, match.index + match[0].length] as const,
        )
      : [];
    for (const [start, end] of numericTokens(entry.text)) {
      if (placeholders.some(([from, to]) => from <= start && end <= to)) continue;
      if (!covering.some(([from, to]) => from <= start && end <= to)) {
        issues.push({ code: 'number_unbound', path: `${entry.path}@${start}` });
      }
    }
  }

  for (const { block, path } of walkBlocks(document.sections)) {
    const bindings = byBlock.get(block.id) ?? [];
    if (block.type === 'chart' && bindings.length === 0) issues.push({ code: 'numeric_block_unbound', path });
    if (block.type !== 'simulation' || isIllustrative(block.data)) continue;
    if (bindings.length === 0) issues.push({ code: 'simulation_unbound', path });
    const boundConstants = new Set(
      bindings.flatMap((binding) => (binding.kind === 'constant' ? [binding.constantKey] : [])),
    );
    const boundPaths = new Set(bindings.flatMap((binding) => (binding.kind === 'value' ? [binding.path] : [])));
    for (const number of simulationNumbers(block.data)) {
      if (STRUCTURAL_LITERALS.has(number.value) || boundPaths.has(number.path)) continue;
      if (number.constantKey !== undefined) {
        if (!boundConstants.has(number.constantKey))
          issues.push({ code: 'constant_unbound', path: `${path}.data.${number.path}` });
      } else issues.push({ code: 'simulation_number_unbound', path: `${path}.data.${number.path}` });
    }
  }
  return issues;
}
