import type { AnyBlock } from '../blocks/catalog.js';
import { walkBlocks, type Section } from '../document.js';
import type { Issue } from '../issues.js';
import { projectText, visibleTexts } from '../registry.js';
import { formulaLiterals } from '../simulation/evaluate.js';
import { containsDigit, sentenceRanges } from '../text.js';
import type { Claim, ProvenanceBinding } from './provenance.js';

/**
 * Honesty checks (`scroll-checks.v1`, evidence stage): pure functions of a document's sections
 * and its provenance. They prove that numbers are anchored to claims; they cannot prove that a
 * claim is true or that the prose says what the claim says (that is content review, blueprint §11).
 *
 * 1. In a text block (paragraph, list, quote, callout), every sentence that contains a digit
 *    overlaps a passage binding (`numeric_sentence_unbound`).
 * 2. Any other block with a digit in its visible text, fallback text or alternative text — and
 *    every chart — has at least one binding (`numeric_block_unbound`). Code, and simulations marked
 *    illustrative, are exempt; section headings, title, dek and kicker are not checked (they cannot
 *    be bound).
 * 3. A simulation not marked illustrative binds every constant to a claim (`constant_unbound`).
 * 4. No simulation hides an empirical number as a literal operand: only 0, ±1, 2 and 0.5 may
 *    appear bare; every other number is a declared, labelled constant (`literal_not_declared`).
 */

/** Numbers that state the shape of a formula rather than a quantity. */
export const STRUCTURAL_LITERALS: ReadonlySet<number> = new Set([0, 1, -1, 2, 0.5]);

interface HonestyInput {
  readonly claims: readonly Pick<Claim, 'claimId'>[];
  readonly bindings: readonly ProvenanceBinding[];
}

/** Text of a block that is not part of its passage projection but can still carry a number. */
function otherTexts(block: AnyBlock): string[] {
  const projected = projectText(block) !== null;
  const texts: string[] = projected ? [] : [...visibleTexts(block), block.fallbackText];
  if (block.a11y.description !== undefined) texts.push(block.a11y.description);
  switch (block.type) {
    case 'quote':
      if (block.data.attribution !== undefined) texts.push(block.data.attribution);
      break;
    case 'callout':
      if (block.data.title !== undefined) texts.push(block.data.title);
      break;
    case 'figure':
      texts.push(block.data.alt);
      break;
    case 'media':
      texts.push(block.data.alt, block.data.transcript);
      break;
    case 'sequence':
      for (const step of block.data.steps) if (step.figure !== undefined) texts.push(step.figure.alt);
      break;
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'disclosure':
    case 'code':
    case 'table':
    case 'comparison':
    case 'timeline':
    case 'diagram':
    case 'chart':
    case 'simulation':
    case 'fallback':
      break;
  }
  return texts;
}

function exemptFromNumericRule(block: AnyBlock): boolean {
  return block.type === 'code' || block.type === 'fallback' || (block.type === 'simulation' && block.data.illustrative);
}

/** Binding integrity: claims, blocks, ranges and constants that a binding names must exist. */
export function bindingIssues(sections: readonly Section[], provenance: HonestyInput): Issue[] {
  const issues: Issue[] = [];
  const claims = new Set(provenance.claims.map((claim) => claim.claimId));
  const blocks = new Map<string, AnyBlock>();
  for (const visit of walkBlocks(sections)) blocks.set(visit.block.id, visit.block);
  provenance.bindings.forEach((binding, index) => {
    const path = `bindings.${index}`;
    if (!claims.has(binding.claimId)) issues.push({ code: 'binding_claim_unknown', path });
    const block = blocks.get(binding.blockId);
    if (block === undefined) {
      issues.push({ code: 'binding_block_unknown', path });
      return;
    }
    if (binding.kind === 'passage') {
      const text = projectText(block);
      if (text === null) issues.push({ code: 'binding_block_not_text', path });
      else if (!(binding.start < binding.end) || binding.end > text.length)
        issues.push({ code: 'binding_range_invalid', path });
    } else if (binding.kind === 'constant') {
      if (
        block.type !== 'simulation' ||
        !block.data.constants.some((constant) => constant.key === binding.constantKey)
      ) {
        issues.push({ code: 'binding_constant_unknown', path });
      }
    }
  });
  return issues;
}

/** The honesty rules above, after binding integrity. */
export function honestyIssues(sections: readonly Section[], provenance: HonestyInput): Issue[] {
  const issues = bindingIssues(sections, provenance);
  const byBlock = new Map<string, ProvenanceBinding[]>();
  for (const binding of provenance.bindings)
    byBlock.set(binding.blockId, [...(byBlock.get(binding.blockId) ?? []), binding]);

  for (const { block, path } of walkBlocks(sections)) {
    const bindings = byBlock.get(block.id) ?? [];
    const text = projectText(block);
    if (text !== null) {
      const ranges = bindings.flatMap((binding) =>
        binding.kind === 'passage' ? [[binding.start, binding.end] as const] : [],
      );
      for (const [start, end] of sentenceRanges(text)) {
        if (!containsDigit(text.slice(start, end))) continue;
        if (!ranges.some(([from, to]) => from < end && to > start)) {
          issues.push({ code: 'numeric_sentence_unbound', path: `${path}@${start}` });
        }
      }
    }
    if (!exemptFromNumericRule(block) && bindings.length === 0) {
      const numericData =
        block.type === 'chart' ||
        (block.type === 'table' && block.data.rows.some((row) => row.some((cell) => typeof cell === 'number')));
      if (numericData || otherTexts(block).some(containsDigit)) issues.push({ code: 'numeric_block_unbound', path });
    }
    if (block.type === 'simulation') {
      if (!block.data.illustrative) {
        for (const constant of block.data.constants) {
          const bound = bindings.some((binding) => binding.kind === 'constant' && binding.constantKey === constant.key);
          if (!bound) issues.push({ code: 'constant_unbound', path: `${path}.data.constants.${constant.key}` });
        }
      }
      const literals = block.data.outputs.flatMap((output) => formulaLiterals(output.formula));
      if (literals.some((literal) => !STRUCTURAL_LITERALS.has(literal))) {
        issues.push({ code: 'literal_not_declared', path: `${path}.data.outputs` });
      }
    }
  }
  return issues;
}
