import { z } from 'zod';
import { FIELD_LIMITS, LIMITS } from '@knowscroll/scroll-model';
import { DraftBinding, DraftBlock, DraftSection, ScrollDraft } from '@knowscroll/scroll-model/producer';

/** A code-owned canonical selection must exist exactly once; never widen or guess on drift. */
export function onlyCanonicalOption<T, U extends T>(options: readonly T[], select: (option: T) => option is U): U {
  const matches = options.filter(select);
  if (matches.length !== 1 || matches[0] === undefined) throw new Error('WRITER_CANONICAL_SELECTION_INVALID');
  return matches[0];
}

type BlockOption = (typeof DraftBlock.options)[number];
type BindingOption = (typeof DraftBinding.options)[number];
function block<T extends z.infer<typeof DraftBlock>['type']>(type: T) {
  return onlyCanonicalOption(
    DraftBlock.options,
    (option): option is Extract<BlockOption, { shape: { type: z.ZodLiteral<T> } }> => option.shape.type.value === type,
  );
}
function binding<T extends z.infer<typeof DraftBinding>['kind']>(kind: T) {
  return onlyCanonicalOption(
    DraftBinding.options,
    (option): option is Extract<BindingOption, { shape: { kind: z.ZodLiteral<T> } }> =>
      option.shape.kind.value === kind,
  );
}

const paragraph = block('paragraph');
const callout = block('callout');
const canonicalDiagram = block('diagram');
const diagramData = canonicalDiagram.shape.data;
const toggle = onlyCanonicalOption(
  diagramData.shape.interaction.options,
  (
    option,
  ): option is Extract<
    (typeof diagramData.shape.interaction.options)[number],
    { shape: { kind: z.ZodLiteral<'toggle'> } }
  > => option.shape.kind.value === 'toggle',
);
const diagram = canonicalDiagram
  .safeExtend({
    data: diagramData.safeExtend({
      interaction: toggle,
      frames: diagramData.shape.frames.min(2).max(4),
    }),
  })
  .required({ a11y: true, fallbackText: true });
const canonicalComparison = block('comparison');
const comparisonData = canonicalComparison.shape.data;
const column = comparisonData.shape.columns.element;
const comparison = canonicalComparison
  .safeExtend({
    data: comparisonData.safeExtend({
      columns: z
        .array(column.safeExtend({ points: column.shape.points.length(2) }))
        .min(2)
        .max(FIELD_LIMITS.comparisonColumns)
        .length(2),
    }),
  })
  .required({ a11y: true, fallbackText: true });
// This writer binds prose through its canonical projection, never a JSON/schema path.
// Other canonical producers may name non-text fields; this selected profile uses block bindings there.
const passage = binding('passage').safeExtend({ field: z.literal('text').optional() });
const bindings = z.discriminatedUnion('kind', [passage, binding('header'), binding('heading'), binding('block')]);

const interactiveBlocks = z.discriminatedUnion('type', [paragraph, diagram, callout]);
const comparisonBlocks = z.discriminatedUnion('type', [paragraph, comparison, callout]);

function profile(blocks: typeof interactiveBlocks | typeof comparisonBlocks) {
  // Only these array wrappers change their element; their canonical min/max bounds stay exact.
  // Every object/field/data/refinement comes from the existing canonical nodes, without a copy.
  return ScrollDraft.safeExtend({
    sections: z
      .array(DraftSection.safeExtend({ blocks: z.array(blocks).min(1).max(LIMITS.blocks) }))
      .min(1)
      .max(LIMITS.sections),
    bindings: z.array(bindings).max(LIMITS.blocks * 6),
  });
}
const interactiveProfile = profile(interactiveBlocks);
const comparisonProfile = profile(comparisonBlocks);

/** A strict canonical subset for this producer, never a new Scroll DSL or publication authority. */
export function writerDraftProfile(interactive: boolean) {
  return interactive ? interactiveProfile : comparisonProfile;
}
