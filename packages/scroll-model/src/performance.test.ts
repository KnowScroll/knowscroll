/**
 * Validation cost (review of #254, M1, and the coordinator's ruling on it). Two paths, two budgets.
 *
 * - ADMISSION (server, worker, producer): every check including the full-grid finiteness proof of
 *   each simulation (at most 10,000 grid points). Worst-case simulation block < 10 ms; worst-case
 *   stored document < 200 ms.
 * - CLIENT (the device): structure, bounds and cheap checks only, never the grid proof; Hermes has
 *   no JIT, so the proof would cost tens to hundreds of milliseconds per Scroll on a phone.
 *   Worst-case simulation block < 1 ms; worst-case document < 20 ms (this includes the measures
 *   check and the integrity hash).
 *
 * The worst inputs are in `test-support/worst-case.ts`: the largest grid with six outputs that all
 * depend on every parameter, five of them fractional powers, twelve constants and a cards view;
 * and a document holding four of them at the block, interactive-block and media limits.
 *
 * Timings are medians, after warm-up, of the CPU time of the test process (`process.cpuUsage`):
 * the CI runner shares its cores with the other packages' test suites, so wall-clock time there
 * measures the wait for a core as much as the work. Both are printed as the CI record. Each run
 * validates a fresh copy of the input that was made before the clock started.
 */
import { describe, expect, it } from 'vitest';
import { admitBlock, admitDocument, LIMITS, parseBlock, parseDocument, simulationGridPoints } from './index.js';
import { worstDocument, worstSimulation } from './test-support/worst-case.js';

interface Cost {
  readonly cpu: number;
  readonly wall: number;
}

function median(samples: number[]): number {
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

/** Median CPU and wall-clock milliseconds of `run` on a fresh copy of `input`, after warm-up. */
function measure<T>(input: T, run: (copy: T) => unknown, times: number): Cost {
  const copies = Array.from({ length: times + 3 }, () => structuredClone(input));
  for (const copy of copies.splice(0, 3)) run(copy);
  const cpu: number[] = [];
  const wall: number[] = [];
  for (const copy of copies) {
    const cpuStarted = process.cpuUsage();
    const started = performance.now();
    run(copy);
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

describe('validation cost (M1 ruling): admission', () => {
  it('proves a worst-case simulation block in under 10 ms (admission)', () => {
    const block = worstSimulation('heaviest');
    if (block.type !== 'simulation') throw new Error('not a simulation');
    expect(simulationGridPoints(block.data)).toBe(LIMITS.simulationGridPoints);
    expect(admitBlock(block).kind).toBe('block');
    const cost = measure(block, admitBlock, 25);
    record('admission worst-case simulation block', cost);
    expect(cost.cpu).toBeLessThan(10);
  });

  it('validates a worst-case stored document in under 200 ms (admission)', () => {
    const document = worstDocument();
    const outcome = admitDocument(document);
    expect(outcome.kind, JSON.stringify(outcome.kind === 'invalid' ? outcome.issues.slice(0, 5) : [])).toBe('valid');
    const cost = measure(document, admitDocument, 9);
    record('admission worst-case document', cost);
    expect(cost.cpu).toBeLessThan(200);
  });
});

describe('validation cost (M1 ruling): client', () => {
  it('parses a worst-case simulation block in under 1 ms (client)', () => {
    const block = worstSimulation('heaviest');
    expect(parseBlock(block).kind).toBe('block');
    const cost = measure(block, parseBlock, 51);
    record('client worst-case simulation block', cost);
    expect(cost.cpu).toBeLessThan(1);
  });

  it('parses a worst-case document in under 20 ms (client)', () => {
    const document = worstDocument();
    const outcome = parseDocument(document);
    expect(outcome.kind, JSON.stringify(outcome.kind === 'invalid' ? outcome.issues.slice(0, 5) : [])).toBe('valid');
    const cost = measure(document, parseDocument, 21);
    record('client worst-case document', cost);
    expect(cost.cpu).toBeLessThan(20);
  });
});

describe('cost that the budgets do not cover (informational, no budget)', () => {
  it('records what asking for the measures and the hash adds to a client parse', () => {
    const document = worstDocument();
    expect(parseDocument(document, { verify: true }).kind).toBe('valid');
    record(
      'client worst-case document with verify (informational)',
      measure(document, (copy) => parseDocument(copy, { verify: true }), 21),
    );
  });
});
