/**
 * Validation cost (review of #254, M1). A renderer parses each block on the device and the server
 * validates every stored revision, so the worst valid inputs must stay cheap. Every simulation is
 * proven over its whole grid (at most 10,000 points), so the worst simulation is the largest grid
 * with six outputs that all depend on every parameter, five of them fractional powers (the
 * costliest formula: `Math.pow` with a non-integer exponent), twelve constants and a cards view
 * (whose bars are checked for negatives at every point).
 *
 * Timings are medians, after warm-up, of the CPU time of the test process (`process.cpuUsage`):
 * the CI runner shares its cores with the other packages' test suites, so wall-clock time there
 * measures the wait for a core as much as the work. Both are printed as the CI record.
 */
import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  parseBlock,
  simulationGridPoints,
  validateDocument,
  type Block,
  type SimulationData,
} from './index.js';
import { make, seal } from './test-support/arbitraries.js';

const format = { decimals: 0, grouping: false, approximate: false };
const letters = 'abcdefghijklmnopqrstuvwxyz';

/** 625 × 2 × 2 × 4 = 10,000 grid points; every output depends on all four parameters. */
function worstSimulation(id: string): Block {
  const param = (key: string, max: number) => ({
    key,
    label: `Dial ${key}`,
    min: 1,
    max,
    step: 1,
    default: 1,
    control: 'slider' as const,
    format,
  });
  const power = (key: string, exponent: number) => ({
    key,
    label: 'Power',
    formula: { kind: 'power' as const, x: 'all', base: 'ka', exponent, scale: 'kb' },
    format,
  });
  const outputs = [
    { key: 'all', label: 'Product', formula: { kind: 'product' as const, factors: ['a', 'b', 'c', 'd'] }, format },
    power('pa', 1.37),
    power('pb', 0.75),
    power('pc', -0.37),
    power('pd', 2.5),
    power('pe', 3.21),
  ];
  const data: SimulationData = {
    title: 'The heaviest simulation',
    params: [param('a', 625), param('b', 2), param('c', 2), param('d', 4)],
    constants: Array.from({ length: 12 }, (_, index) => ({
      key: `k${letters.charAt(index)}`,
      label: 'A constant',
      value: 1.5,
    })),
    outputs,
    view: {
      kind: 'cards',
      items: outputs.map((output, index) => ({
        id: `card-${letters.charAt(index)}`,
        label: 'Card',
        output: output.key,
      })),
    },
    readout: { template: 'The product is {all}', bands: [{ output: 'pa', min: 1, text: 'Above one.' }] },
    modelNote: 'The heaviest simulation the limits allow.',
    illustrative: { notice: 'Illustrative' },
  };
  return { ...make('simulation', data), id, a11y: { label: 'Heaviest', description: 'D'.repeat(599).concat('.') } };
}

interface Cost {
  readonly cpu: number;
  readonly wall: number;
}

function median(samples: number[]): number {
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

/** Median CPU and wall-clock milliseconds of `run`, after warm-up. */
function measure(run: () => unknown, times: number): Cost {
  for (let warm = 0; warm < 3; warm += 1) run();
  const cpu: number[] = [];
  const wall: number[] = [];
  for (let index = 0; index < times; index += 1) {
    const cpuStarted = process.cpuUsage();
    const started = performance.now();
    run();
    wall.push(performance.now() - started);
    const used = process.cpuUsage(cpuStarted);
    cpu.push((used.user + used.system) / 1000);
  }
  return { cpu: median(cpu), wall: median(wall) };
}

function record(label: string, cost: Cost): void {
  // eslint-disable-next-line no-console -- the measured cost is the CI record M1 asks for
  console.info(`${label}: median CPU ${cost.cpu.toFixed(2)} ms, wall ${cost.wall.toFixed(2)} ms`);
}

describe('validation cost (M1)', () => {
  it('parses and proves a worst-case simulation block in under 5 ms', () => {
    const block = worstSimulation('heaviest');
    if (block.type !== 'simulation') throw new Error('not a simulation');
    expect(simulationGridPoints(block.data)).toBe(LIMITS.simulationGridPoints);
    expect(parseBlock(block).kind).toBe('block');
    const cost = measure(() => parseBlock(structuredClone(block)), 15);
    record('worst-case simulation parseBlock', cost);
    expect(cost.cpu).toBeLessThan(5);
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
    const cost = measure(() => validateDocument(structuredClone(document)), 7);
    record('worst-case document validateDocument', cost);
    expect(cost.cpu).toBeLessThan(200);
  });
});
