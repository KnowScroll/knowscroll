/**
 * The most expensive valid inputs the limits allow, for the cost budgets (`performance.test.ts`).
 * The worst simulation is the largest grid (10,000 points) with six outputs that all depend on
 * every parameter, five of them fractional powers (the costliest formula: `Math.pow` with a
 * non-integer exponent), twelve constants and a cards view (whose bars are checked for negatives
 * at every point). The worst document holds eight of them with two parameters each (the
 * 16-parameter and 8-interactive-block limits, 80,000 grid points), twelve figures and paragraphs
 * up to the 80-block limit.
 */
import { LIMITS, type Block, type ScrollDocument } from '../index.js';
import { make, seal, type SimulationInput } from './arbitraries.js';

const format = { decimals: 0, grouping: false, approximate: false };
const letters = 'abcdefghijklmnopqrstuvwxyz';

/** The six-output, twelve-constant, cards-view simulation over the given parameters (all depend on every one). */
function heaviest(id: string, params: SimulationInput['params'], factors: string[]): Block {
  const power = (key: string, exponent: number) => ({
    key,
    label: 'Power',
    formula: { kind: 'power' as const, x: 'all', base: 'ka', exponent, scale: 'kb' },
    format,
  });
  const outputs = [
    { key: 'all', label: 'Product', formula: { kind: 'product' as const, factors }, format },
    power('pa', 1.37),
    power('pb', 0.75),
    power('pc', -0.37),
    power('pd', 2.5),
    power('pe', 3.21),
  ];
  const data: SimulationInput = {
    title: 'The heaviest simulation',
    params,
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

/** 625 × 2 × 2 × 4 = 10,000 grid points over four parameters; every output depends on all four. */
export function worstSimulation(id: string): Block {
  return heaviest(id, [param('a', 625), param('b', 2), param('c', 2), param('d', 4)], ['a', 'b', 'c', 'd']);
}

/** 100 × 100 = 10,000 grid points over two parameters: the shape that fits eight simulations in 16 parameters. */
export function worstTwoParameterSimulation(id: string): Block {
  return heaviest(id, [param('a', 100), param('b', 100)], ['a', 'b']);
}

/**
 * A stored revision at the block, interactive-block, media and parameter limits. The 16 parameters
 * allow four simulations of four parameters (40,000 grid points) or eight of two (80,000): this is
 * the larger, eight simulations of 100 × 100 points each, so also the interactive-block limit.
 */
export function worstDocument(): ScrollDocument {
  const blocks: Block[] = [];
  for (let index = 0; index < LIMITS.paramsTotal / 2; index += 1)
    blocks.push(worstTwoParameterSimulation(`sim-${letters.charAt(index)}`));
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
  return seal(sections);
}
