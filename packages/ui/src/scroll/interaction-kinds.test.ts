import { INTERACTION_KINDS } from '@knowscroll/scroll-model';
import type { InteractionBlockType, InteractionKindOf, ScrollInteraction, ScrollInteractionKind } from './observer';
import type { ScrollRenderContext } from './context';

/**
 * ONE interaction vocabulary: the package's `INTERACTION_KINDS`. The type guarantees are
 * compile-time (`tsc` in the static job); each `@ts-expect-error` below fails the build if the
 * line beside it ever starts to compile.
 */

describe('the interaction vocabulary', () => {
  it('is the union of the package’s INTERACTION_KINDS values, per block type', () => {
    const everyKind: readonly string[] = Object.values(INTERACTION_KINDS).flat();
    const kind: ScrollInteractionKind = 'copied';
    const own: InteractionKindOf<'sequence'> = 'step-changed';
    expect(everyKind).toContain(kind);
    expect(everyKind).toContain(own);
  });

  it('refuses another block type’s kind', () => {
    // @ts-expect-error a code block cannot report a step change
    const wrongKind: InteractionKindOf<'code'> = 'step-changed';
    // @ts-expect-error `retry` and the other withdrawn names are not kinds at all
    const withdrawn: ScrollInteractionKind = 'retry';
    // @ts-expect-error the observer's event is a union over the block type: a disclosure cannot say `copied`
    const mismatched: ScrollInteraction = { blockId: 'd', blockType: 'disclosure', kind: 'copied', at: 0 };
    const fine: ScrollInteraction = { blockId: 'c', blockType: 'code', kind: 'copied', at: 0 };
    expect([wrongKind, withdrawn, mismatched.kind, fine.kind]).toHaveLength(4);
  });

  it('is the only way a renderer reports: report(blockId, blockType, kind) with the type’s own kinds', () => {
    const report: ScrollRenderContext['report'] = jest.fn();
    report('c', 'code', 'copied');
    report('d', 'disclosure', 'expanded');
    // @ts-expect-error a code block cannot report a step change
    report('c', 'code', 'step-changed');
    // @ts-expect-error a fallback declares no interaction kinds
    report('f', 'fallback', 'retry');
    const types: InteractionBlockType[] = Object.keys(INTERACTION_KINDS) as InteractionBlockType[];
    expect(types).toContain('code');
  });
});
