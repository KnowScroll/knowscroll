import { z } from './zod.js';
import type { AnyBlock, BlockType } from './blocks/catalog.js';
import { canonicalSize } from './canonical.js';
import { LIMITS } from './limits.js';
import { BlockTypeName, BlockVersionNumber, FiniteNumber, LocalId, ParamKey } from './primitives.js';
import { INTERACTION_KINDS } from './registry.js';
import { formatWithUnit, isOnGrid } from './simulation/evaluate.js';

/**
 * Reader state of a block, persisted by (account scope, privacy epoch, asset, revision, block id)
 * on the device, and carried in a snippet only as an explicit snapshot.
 */
export const BlockState = z.discriminatedUnion('type', [
  /** Parameter values; a snapshot may omit some (personal values left out), which take their defaults. */
  z.strictObject({ type: z.literal('simulation'), params: z.record(ParamKey, FiniteNumber) }),
  z.strictObject({ type: z.literal('diagram'), frame: LocalId }),
  z.strictObject({ type: z.literal('sequence'), step: LocalId }),
  z.strictObject({ type: z.literal('disclosure'), expanded: z.boolean() }),
]);
export type BlockState = z.infer<typeof BlockState>;

/** A block state as shared in a `scroll_block` snippet; says whether personal values travel with it. */
export const BlockStateSnapshot = z.strictObject({
  state: BlockState,
  personalIncluded: z.boolean(),
});
export type BlockStateSnapshot = z.infer<typeof BlockStateSnapshot>;

/** The state a block starts in, or null for blocks without state. */
export function defaultBlockState(block: AnyBlock): BlockState | null {
  switch (block.type) {
    case 'simulation':
      return {
        type: 'simulation',
        params: Object.fromEntries(block.data.params.map((param) => [param.key, param.default])),
      };
    case 'diagram': {
      const interaction = block.data.interaction;
      if (interaction.kind === 'static') return null;
      const frame = interaction.kind === 'drag-to-target' ? interaction.initialFrame : block.data.frames[0]?.id;
      return frame === undefined ? null : { type: 'diagram', frame };
    }
    case 'sequence': {
      const step = block.data.steps[0]?.id;
      return step === undefined ? null : { type: 'sequence', step };
    }
    case 'disclosure':
      return { type: 'disclosure', expanded: false };
    case 'paragraph':
    case 'subheading':
    case 'list':
    case 'quote':
    case 'callout':
    case 'code':
    case 'table':
    case 'figure':
    case 'media':
    case 'comparison':
    case 'timeline':
    case 'chart':
    case 'fallback':
      return null;
  }
}

export type StateProblem =
  'block-has-no-state' | 'state-type-mismatch' | 'param-unknown' | 'param-off-grid' | 'frame-unknown' | 'step-unknown';

/**
 * Checks a state against the block it belongs to. `partial` allows a simulation state that omits
 * parameters (a snapshot without personal values); a full state names every parameter.
 */
export function blockStateProblems(
  block: AnyBlock,
  state: BlockState,
  options: { partial?: boolean } = {},
): StateProblem[] {
  const problems: StateProblem[] = [];
  if (defaultBlockState(block) === null) return ['block-has-no-state'];
  if (state.type !== block.type) return ['state-type-mismatch'];
  if (block.type === 'simulation' && state.type === 'simulation') {
    const params = new Map(block.data.params.map((param) => [param.key, param]));
    for (const [key, value] of Object.entries(state.params)) {
      const param = params.get(key);
      if (param === undefined) problems.push('param-unknown');
      else if (!isOnGrid(param, value)) problems.push('param-off-grid');
    }
    if (options.partial !== true && block.data.params.some((param) => !Object.hasOwn(state.params, param.key))) {
      problems.push('param-unknown');
    }
  } else if (block.type === 'diagram' && state.type === 'diagram') {
    if (!block.data.frames.some((frame) => frame.id === state.frame)) problems.push('frame-unknown');
  } else if (block.type === 'sequence' && state.type === 'sequence') {
    if (!block.data.steps.some((step) => step.id === state.step)) problems.push('step-unknown');
  }
  return [...new Set(problems)];
}

/** Keys of the block's personal parameters. */
export function personalParamKeys(block: AnyBlock): string[] {
  return block.type === 'simulation'
    ? block.data.params.filter((param) => param.personal === true).map((param) => param.key)
    : [];
}

export type SnapshotOutcome =
  | { readonly kind: 'snapshot'; readonly snapshot: BlockStateSnapshot }
  | { readonly kind: 'stateless' }
  | { readonly kind: 'invalid-state'; readonly problems: readonly StateProblem[] }
  | { readonly kind: 'too-large' };

/**
 * Builds the block-state snapshot a `scroll_block` snippet carries. Personal parameter values are
 * left out unless the sender explicitly includes them (`includePersonal`, default false);
 * `personalIncluded` records whether any travelled, so the card can say so (D-006 g).
 */
export function buildBlockStateSnapshot(
  block: AnyBlock,
  state: BlockState,
  options: { includePersonal?: boolean } = {},
): SnapshotOutcome {
  if (defaultBlockState(block) === null) return { kind: 'stateless' };
  const problems = blockStateProblems(block, state);
  if (problems.length > 0) return { kind: 'invalid-state', problems };
  let snapshotState = state;
  let personalIncluded = false;
  if (state.type === 'simulation') {
    const personal = new Set(personalParamKeys(block));
    const include = options.includePersonal === true;
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(state.params)) {
      if (personal.has(key) && !include) continue;
      params[key] = value;
      if (personal.has(key)) personalIncluded = true;
    }
    snapshotState = { type: 'simulation', params };
  }
  const snapshot: BlockStateSnapshot = { state: snapshotState, personalIncluded };
  if (canonicalSize(snapshot) > LIMITS.blockStateBytes) return { kind: 'too-large' };
  return { kind: 'snapshot', snapshot };
}

/**
 * Human-readable summary of a state for a server-rendered snippet card ("Sentence length · 4,096
 * words"). Built only from the block's own labels, never from client text.
 */
export function describeBlockState(block: AnyBlock, state: BlockState): string {
  if (block.type === 'simulation' && state.type === 'simulation') {
    return block.data.params
      .filter((param) => Object.hasOwn(state.params, param.key))
      .map((param) => `${param.label} · ${formatWithUnit(state.params[param.key] ?? null, param.format, param.unit)}`)
      .join(' · ');
  }
  if (block.type === 'diagram' && state.type === 'diagram') {
    return block.data.frames.find((frame) => frame.id === state.frame)?.label ?? block.a11y.label;
  }
  if (block.type === 'sequence' && state.type === 'sequence') {
    const index = block.data.steps.findIndex((step) => step.id === state.step);
    const step = block.data.steps[index];
    return step === undefined ? block.a11y.label : `Step ${index + 1} of ${block.data.steps.length} · ${step.title}`;
  }
  return block.a11y.label;
}

/**
 * The telemetry payload of a deliberate block interaction (`scroll.block_interaction`). It never
 * carries parameter values, positions or text, so personal values cannot reach telemetry.
 */
export const BlockInteractionPayload = z.strictObject({
  blockId: LocalId,
  blockType: BlockTypeName,
  blockVersion: BlockVersionNumber,
  kind: z.string().regex(/^[a-z][a-z-]{1,31}$/u),
});
export type BlockInteractionPayload = z.infer<typeof BlockInteractionPayload>;

/** The payload for an interaction kind the block type declares, or null for an undeclared kind. */
export function blockInteractionPayload(block: AnyBlock, kind: string): BlockInteractionPayload | null {
  const declared: Partial<Record<BlockType, readonly string[]>> = INTERACTION_KINDS;
  const kinds = declared[block.type] ?? [];
  if (!kinds.includes(kind)) return null;
  return { blockId: block.id, blockType: block.type, blockVersion: block.version, kind };
}
