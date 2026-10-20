import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BlockInteractionPayload,
  blockInteractionPayload,
  blockStateProblems,
  buildBlockStateSnapshot,
  canonicalJson,
  defaultBlockState,
  describeBlockState,
  INTERACTION_KINDS,
  personalParamKeys,
  snapToGrid,
  validateLocator,
  walkBlocks,
  type AnyBlock,
} from './index.js';
import { anyBlock, seal, arrange, simulationBlock } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';

/** A simulation block and an on-grid value for each of its parameters. */
const simulationWithState = simulationBlock.chain((block) =>
  fc
    .array(fc.double({ min: -1e4, max: 1e4, noNaN: true }), {
      minLength: block.data.params.length,
      maxLength: block.data.params.length,
    })
    .map((raw) => ({
      block,
      params: Object.fromEntries(
        block.data.params.map((param, index) => [param.key, snapToGrid(param, raw[index] ?? 0)]),
      ),
    })),
);

describe('block-state snapshots', () => {
  it('leave personal values out unless the sender explicitly includes them', () => {
    fc.assert(
      fc.property(
        simulationWithState,
        fc.option(fc.boolean(), { nil: undefined }),
        ({ block, params }, includePersonal) => {
          const personal = personalParamKeys(block);
          const outcome =
            includePersonal === undefined
              ? buildBlockStateSnapshot(block, { type: 'simulation', params })
              : buildBlockStateSnapshot(block, { type: 'simulation', params }, { includePersonal });
          expect(outcome.kind).toBe('snapshot');
          if (outcome.kind !== 'snapshot' || outcome.snapshot.state.type !== 'simulation') return;
          const shared = outcome.snapshot.state.params;
          for (const param of block.data.params) {
            const isPersonal = personal.includes(param.key);
            const expected = isPersonal && includePersonal !== true ? undefined : params[param.key];
            expect(shared[param.key]).toBe(expected);
          }
          expect(outcome.snapshot.personalIncluded).toBe(includePersonal === true && personal.length > 0);

          const document = seal(arrange([{ heading: 'only', blocks: [block] }]));
          const placed = document.sections[0]?.blocks[0];
          const locator = {
            kind: 'scroll_block' as const,
            assetId: document.assetId,
            revision: document.revision,
            blockId: placed?.id ?? '',
            blockType: 'simulation',
            blockVersion: 1,
            state: outcome.snapshot,
          };
          expect(validateLocator(document, locator, { personalConsent: true }).kind).toBe('valid');
          expect(validateLocator(document, locator).kind).toBe(outcome.snapshot.personalIncluded ? 'invalid' : 'valid');
        },
      ),
      { numRuns: 150 },
    );
  });

  it('are refused for blocks without state and for states that do not fit the block', () => {
    const tides = fixture('spring-neap-tides').document;
    const paragraph = tides.sections[0]?.blocks[0];
    const diagram = tides.sections[0]?.blocks[2];
    if (paragraph === undefined || diagram === undefined) throw new Error('fixture changed');
    expect(buildBlockStateSnapshot(paragraph, { type: 'disclosure', expanded: true })).toEqual({ kind: 'stateless' });
    expect(buildBlockStateSnapshot(diagram, { type: 'diagram', frame: 'no-such-frame' })).toEqual({
      kind: 'invalid-state',
      problems: ['frame-unknown'],
    });
    expect(buildBlockStateSnapshot(diagram, { type: 'sequence', step: 'neap' })).toEqual({
      kind: 'invalid-state',
      problems: ['state-type-mismatch'],
    });
    expect(buildBlockStateSnapshot(diagram, { type: 'diagram', frame: 'neap' })).toEqual({
      kind: 'snapshot',
      snapshot: { state: { type: 'diagram', frame: 'neap' }, personalIncluded: false },
    });
  });

  it('describe a state with the block’s own labels for server-rendered cards', () => {
    const attention = fixture('attention-slowly').document;
    const sim = attention.sections[1]?.blocks[2];
    const diagram = attention.sections[0]?.blocks[2];
    if (sim === undefined || diagram === undefined) throw new Error('fixture changed');
    expect(describeBlockState(sim, { type: 'simulation', params: { len: 4_096 } })).toBe(
      'Sentence length · 4,096 words',
    );
    expect(describeBlockState(diagram, { type: 'diagram', frame: 'means-street' })).toBe('…because it was too wide');
    const tides = fixture('spring-neap-tides').document;
    const sequenceLike = tides.sections[1]?.blocks[1];
    if (sequenceLike === undefined) throw new Error('fixture changed');
    expect(describeBlockState(sequenceLike, { type: 'simulation', params: { sunShare: 0.9 } })).toBe(
      'Sun’s pull compared with the Moon’s · 0.90',
    );
  });
});

describe('default block state', () => {
  it('exists exactly for simulations, interactive diagrams, sequences and disclosures, and fits its block', () => {
    fc.assert(
      fc.property(anyBlock, (block: AnyBlock) => {
        const state = defaultBlockState(block);
        const stateful =
          block.type === 'simulation' ||
          block.type === 'sequence' ||
          block.type === 'disclosure' ||
          (block.type === 'diagram' && block.data.interaction.kind !== 'static');
        expect(state !== null).toBe(stateful);
        if (state !== null) expect(blockStateProblems(block, state)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

describe('telemetry payloads', () => {
  it('carry only block id, type, version and a declared interaction kind — never values', () => {
    const blocks = [fixture('weight-other-worlds'), fixture('attention-slowly'), fixture('spring-neap-tides')].flatMap(
      (item) => [...walkBlocks(item.document.sections)].map((visit) => visit.block),
    );
    const declared: Partial<Record<string, readonly string[]>> = INTERACTION_KINDS;
    for (const block of blocks) {
      for (const kind of declared[block.type] ?? []) {
        const payload = blockInteractionPayload(block, kind);
        expect(payload).toEqual({ blockId: block.id, blockType: block.type, blockVersion: 1, kind });
        expect(Object.keys(payload ?? {}).sort()).toEqual(['blockId', 'blockType', 'blockVersion', 'kind']);
      }
      expect(blockInteractionPayload(block, 'weight-entered')).toBeNull();
    }
    const weight = blocks.find((block) => block.id === 'weight-sim');
    if (weight === undefined) throw new Error('fixture changed');
    expect(canonicalJson(blockInteractionPayload(weight, 'param-changed'))).not.toMatch(/weightKg|\d{2}/u);
    expect(
      BlockInteractionPayload.safeParse({
        blockId: 'weight-sim',
        blockType: 'simulation',
        blockVersion: 1,
        kind: 'param-changed',
        weightKg: 72,
      }).success,
    ).toBe(false);
  });
});
