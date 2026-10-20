/**
 * Validation cost (review of #254, M1, and the coordinator's ruling on it). Two paths, two budgets.
 *
 * - ADMISSION (server, worker, producer): every check including the full-grid finiteness proof of
 *   each simulation (at most 10,000 grid points). Worst-case simulation block < 10 ms; worst-case
 *   stored document < 200 ms.
 * - CLIENT (the device): structure, bounds and cheap checks only, never the grid proof; Hermes has
 *   no JIT, so the proof would cost tens to hundreds of milliseconds per Scroll on a phone.
 *   Worst-case simulation block < 1 ms; worst-case document < 20 ms (the measures check and the
 *   integrity hash are skipped, as a device may; an informational record adds them).
 *
 * The worst inputs are in `test-support/worst-case.ts`: the largest grid with six outputs that all
 * depend on every parameter, five of them fractional powers, twelve constants and a cards view;
 * and a document holding eight simulations of two parameters (80,000 grid points) at the block,
 * interactive-block, media and parameter limits.
 *
 * Validation is also linear in the text it is given (re-review of #254, MA-1): hostile text at the
 * field maximum and at the document maximum costs milliseconds, and text over its limit costs no
 * scan at all. Those cases are the last describe block.
 *
 * Timings are medians, after warm-up, of the CPU time of the test process (`process.cpuUsage`):
 * the CI runner shares its cores with the other packages' test suites, so wall-clock time there
 * measures the wait for a core as much as the work. Both are printed as the CI record. Each run
 * validates a fresh copy of the input that was made before the clock started.
 */
import { describe, expect, it } from 'vitest';
import {
  admitBlock,
  admitDocument,
  canonicalJson,
  LIMITS,
  parseBlock,
  parseDocument,
  simulationGridPoints,
  utf8ByteLength,
} from './index.js';
import { validateDraft } from './producer/index.js';
import { make, seal } from './test-support/arbitraries.js';
import { fixture } from './test-support/fixtures.js';
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

describe('hostile text costs time linear in its length (MA-1)', () => {
  const weight = fixture('weight-other-worlds');
  /** Long dotted or hyphenated runs with no listed host suffix: the shapes that cost O(length²) in a regular expression. */
  const dotted = (characters: number, unit = 'a.') => unit.repeat(Math.ceil(characters / unit.length));
  type Loose = Record<string, unknown>;

  it('refuses an 85 KB document whose title is a long dotted string, on both paths, within the budgets', () => {
    const document = { ...weight.document, title: dotted(81_000) };
    expect(JSON.stringify(document).length).toBeGreaterThan(85_000);
    for (const outcome of [parseDocument(document), admitDocument(document)])
      expect(outcome).toMatchObject({ kind: 'invalid', issues: [{ code: 'schema_too_big', path: 'title' }] });
    const client = measure(document, parseDocument, 5);
    record('client 85 KB document with a dotted 81,000-character title', client);
    expect(client.cpu).toBeLessThan(20);
    const admission = measure(document, admitDocument, 5);
    record('admission 85 KB document with a dotted 81,000-character title', admission);
    expect(admission.cpu).toBeLessThan(200);
  });

  it('does the same for a field near the document maximum, whatever the dotted or hyphenated shape', () => {
    for (const unit of ['a.', 'a-b-', 'abc.def.', '1.2.', 'A.b-C.']) {
      const document = { ...weight.document, title: dotted(100_000, unit) };
      // Under the 128 KiB gate, so the schema (not the size check) is what refuses it.
      expect(utf8ByteLength(canonicalJson(document))).toBeLessThan(LIMITS.documentBytes);
      expect(parseDocument(document)).toMatchObject({ kind: 'invalid', issues: [{ code: 'schema_too_big' }] });
      const cost = measure(document, parseDocument, 3);
      expect(cost.cpu, unit).toBeLessThan(20);
    }
  });

  it('validates a draft with a 120,000-character field in milliseconds', () => {
    const cases: Array<[string, (draft: Loose) => void]> = [
      [
        'a paragraph',
        (draft) => {
          const sections = draft['sections'] as Array<{ blocks: Array<{ data: Loose }> }>;
          const block = sections[0]?.blocks[1];
          if (block !== undefined) block.data['spans'] = dotted(120_000, 'a1.b2.');
        },
      ],
      ['the dek', (draft) => void (draft['dek'] = dotted(120_000, 'np.linalg.norm.'))],
    ];
    for (const [name, change] of cases) {
      const draft = structuredClone(weight.draft) as Loose;
      change(draft);
      const outcome = validateDraft(draft, weight.provenance);
      expect(outcome, name).toMatchObject({ kind: 'refused', stage: 'schema' });
      const cost = measure(draft, (copy) => validateDraft(copy, weight.provenance), 3);
      record(`validateDraft with a dotted 120,000-character field (${name})`, cost);
      expect(cost.cpu, name).toBeLessThan(200);
    }
  });

  it('validates a document filled to its visible-text limit with hostile paragraphs within the budgets', () => {
    // 20 paragraphs of 1,190 characters make 23,800 of the 24,000 visible characters allowed.
    const hostile = ['a1.b2.', 'a-b-', 'abc.def.'];
    const blocks = Array.from({ length: 20 }, (_, index) => ({
      ...make('paragraph', {
        spans: [
          {
            text: dotted(1_190, hostile[index % hostile.length])
              .slice(0, 1_189)
              .concat('x'),
          },
        ],
      }),
      id: `hostile-${'abcdefghijklmnopqrst'.charAt(index)}`,
    }));
    const document = seal([{ id: 'only', heading: null, blocks }]);
    expect(admitDocument(document).kind).toBe('valid');
    expect(parseDocument(document, { verify: true }).kind).toBe('valid');
    expect(measure(document, parseDocument, 9).cpu).toBeLessThan(20);
    expect(measure(document, admitDocument, 9).cpu).toBeLessThan(200);
  });
});
