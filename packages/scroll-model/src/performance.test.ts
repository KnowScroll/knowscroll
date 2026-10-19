/**
 * Validation cost (review of #254, M1). A renderer parses each block on the device and the server
 * validates every stored revision, so the worst valid inputs must stay cheap: every simulation is
 * proven over its whole grid (at most 10,000 points), so a worst-case simulation is the largest
 * grid, six outputs, twelve constants and a plot. Timings are medians after warm-up, measured on
 * the CI runner.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS, parseBlock, validateDocument, type Block, type SimulationData } from './index.js';
import { make, seal } from './test-support/arbitraries.js';

const format = { decimals: 0, grouping: false, approximate: false };
const letters = 'abcdefghijklmnopqrstuvwxyz';

/** 625 × 2 × 2 × 4 = 10,000 grid points, six outputs, twelve constants, a plot over 625 values. */
function worstSimulation(id: string): Block {
  const param = (key: string, max: number) => ({
    key,
    label: `Dial ${key}`,
    min: 0,
    max,
    step: 1,
    default: 0,
    control: 'slider' as const,
    format,
  });
  const data: SimulationData = {
    title: 'The heaviest simulation',
    params: [param('a', 624), param('b', 1), param('c', 1), param('d', 3)],
    constants: Array.from({ length: 12 }, (_, index) => ({
      key: `k${letters.charAt(index)}`,
      label: 'A constant',
      value: 1.5,
    })),
    outputs: [
      { key: 'oa', label: 'Product', formula: { kind: 'product', factors: ['a', 'b', 'c', 'ka'] }, format },
      { key: 'ob', label: 'Line', formula: { kind: 'linear', x: 'a', a: 'kb', b: 'kc' }, format },
      { key: 'oc', label: 'Power', formula: { kind: 'power', x: 'ob', base: 'kd', exponent: 2, scale: 'ke' }, format },
      { key: 'od', label: 'Growth', formula: { kind: 'exponential', x: 'd', rate: 'kf', initial: 'kg' }, format },
      { key: 'oe', label: 'Pull', formula: { kind: 'inverse-square', r: 'ob', k: 'kh' }, format },
      {
        key: 'of',
        label: 'Table',
        formula: {
          kind: 'lookup',
          input: 'a',
          mode: 'interpolate',
          table: Array.from({ length: 12 }, (_, index) => ({ at: index * 50, value: 'ki' })),
        },
        format,
      },
    ],
    view: { kind: 'plot', x: 'a', y: 'oc', yLabel: 'Curve' },
    readout: { template: 'The curve is {oc}', bands: [{ output: 'oc', min: 1, text: 'Above one.' }] },
    modelNote: 'The heaviest simulation the limits allow.',
    illustrative: { notice: 'Illustrative' },
  };
  return { ...make('simulation', data), id, a11y: { label: 'Heaviest', description: 'D'.repeat(599).concat('.') } };
}

function median(run: () => unknown, times: number): number {
  for (let warm = 0; warm < 3; warm += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('validation cost (M1)', () => {
  it('parses and proves a worst-case simulation block in under 5 ms', () => {
    const block = worstSimulation('heaviest');
    expect(parseBlock(block).kind).toBe('block');
    expect(median(() => parseBlock(structuredClone(block)), 9)).toBeLessThan(5);
  });

  it('validates a worst-case stored document in under 200 ms', () => {
    const blocks: Block[] = [];
    // 16 parameters in total allow four four-parameter simulations; the other interactive blocks are steppers.
    for (let index = 0; index < LIMITS.paramsTotal / LIMITS.paramsPerBlock; index += 1)
      blocks.push(worstSimulation(`sim-${letters.charAt(index)}`));
    while (blocks.length < LIMITS.interactiveBlocks) {
      blocks.push({
        ...make('sequence', {
          title: 'Steps',
          steps: Array.from({ length: 8 }, (_, step) => ({
            id: `step-${letters.charAt(step)}`,
            title: 'A step',
            spans: [{ text: 'Then the next thing happens.' }],
          })),
        }),
        id: `steps-${letters.charAt(blocks.length)}`,
      });
    }
    for (let index = 0; index < LIMITS.mediaBlocks; index += 1) {
      blocks.push({
        ...make('figure', {
          media: { mediaId: 'med-1', revision: 1 },
          motion: 'still',
          alt: `${'A quiet harbour '.repeat(18).slice(0, 290).trim()}.`,
        }),
        id: `figure-${letters.charAt(index)}`,
        a11y: { label: 'Figure', description: `${'Spoken words '.repeat(46).slice(0, 590).trim()}.` },
      });
    }
    const paragraphs = LIMITS.blocks - blocks.length;
    for (let index = 0; index < paragraphs; index += 1) {
      blocks.push({
        ...make('paragraph', { spans: [{ text: `${'Word '.repeat(68).trim()}.` }] }),
        id: `para-${letters.charAt(index % 26)}${letters.charAt(Math.floor(index / 26))}`,
      });
    }
    const sections = Array.from({ length: 4 }, (_, index) => ({
      id: `section-${letters.charAt(index)}`,
      heading: index === 0 ? null : 'A heading',
      blocks: blocks.slice(index * 20, index * 20 + 20),
    }));
    const document = seal(sections);
    const outcome = validateDocument(document);
    expect(outcome.kind, JSON.stringify(outcome.kind === 'invalid' ? outcome.issues.slice(0, 5) : [])).toBe('valid');
    expect(median(() => validateDocument(structuredClone(document)), 5)).toBeLessThan(200);
  });
});
