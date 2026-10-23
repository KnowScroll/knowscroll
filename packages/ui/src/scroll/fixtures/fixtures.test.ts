import { admitDocument, deriveGesture, walkBlocks, type ScrollDocument } from '@knowscroll/scroll-model';
import { bridgesPoster, bridgesWithServerFallback, experimentsPoster, lighthouseEditorial } from './documents';
import { prepareScrollDocument } from '../prepare';

const documents: readonly [string, () => ScrollDocument][] = [
  ['the bridges poster', bridgesPoster],
  ['the lighthouse editorial', lighthouseEditorial],
  ['the experiments poster', experimentsPoster],
  ['the negotiated bridges rendition', bridgesWithServerFallback],
];

describe('the fixture documents', () => {
  it.each(documents)('%s parses on the client path and verifies its hash when asked', (_name, build) => {
    const outcome = prepareScrollDocument(build(), { verify: true });
    if (outcome.kind !== 'ready') throw new Error(`the fixture did not parse: ${JSON.stringify(outcome)}`);
    expect(outcome.document.measures.readingMinutes).toBeGreaterThanOrEqual(1);
  });

  // The server's admission (full-grid proof of every simulation, the display it stores, hash and
  // measures): the fixtures are exactly what a producer could have stored, not only what a client
  // would accept. Tests may call it; the renderer sources never do (prepare.test.ts scans them).
  it.each(documents.slice(0, 3))('%s is admitted as a stored revision', (_name, build) => {
    const outcome = admitDocument(build());
    expect(outcome).toMatchObject({ kind: 'valid' });
  });

  it.each(documents)('%s declares each block’s gesture as the package derives it', (_name, build) => {
    for (const { block } of walkBlocks(build().sections)) expect(block.gesture).toBe(deriveGesture(block));
  });

  it('between them use every block type', () => {
    const types = new Set(
      documents.flatMap(([, build]) => [...walkBlocks(build().sections)].map((visit) => visit.block.type)),
    );
    for (const type of [
      'paragraph',
      'subheading',
      'list',
      'quote',
      'callout',
      'disclosure',
      'code',
      'table',
      'figure',
      'media',
      'comparison',
      'timeline',
      'sequence',
      'diagram',
      'chart',
      'simulation',
      'fallback',
    ]) {
      expect(types.has(type as never)).toBe(true);
    }
  });

  it('keep every personal parameter on the personal side and every simulation illustrative', () => {
    const sims = [...walkBlocks(experimentsPoster().sections)].flatMap((visit) =>
      visit.block.type === 'simulation' ? [visit.block] : [],
    );
    expect(sims).toHaveLength(4);
    expect(sims.every((sim) => sim.data.illustrative !== false)).toBe(true);
    expect(
      sims.flatMap((sim) => sim.data.params.filter((param) => param.personal === true).map((param) => param.key)),
    ).toEqual(['altitude']);
  });
});
