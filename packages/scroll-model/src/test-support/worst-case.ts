/**
 * The most expensive valid inputs the limits allow, for the cost budgets (`performance.test.ts`).
 * The worst simulation is the largest grid (10,000 points) with six outputs that all depend on
 * every parameter, five of them fractional powers (the costliest formula: `Math.pow` with a
 * non-integer exponent), twelve constants and a cards view (whose bars are checked for negatives
 * at every point). The worst document holds four of them (the 16-parameter limit), the other
 * interactive blocks, twelve figures and paragraphs up to the 80-block limit.
 */
import { LIMITS, type Block, type ScrollDocument } from '../index.js';
import { make, seal, type SimulationInput } from './arbitraries.js';

const format = { decimals: 0, grouping: false, approximate: false };
const letters = 'abcdefghijklmnopqrstuvwxyz';

/** 625 × 2 × 2 × 4 = 10,000 grid points; every output depends on all four parameters. */
export function worstSimulation(id: string): Block {
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
  const data: SimulationInput = {
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

/** A stored revision at the block, interactive-block, media and parameter limits. */
export function worstDocument(): ScrollDocument {
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
  return seal(sections);
}
