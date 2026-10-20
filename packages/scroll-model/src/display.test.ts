/**
 * The stored display scale (coordinator ruling after M1): the bar scale and the plot range of
 * every cards, area and plot view are computed by code once, on the admission path, in the same
 * pass that proves the outputs finite; stored in the consumer document as code-set data (covered
 * by the integrity hash, recomputed and compared at admission, never written by the model); and
 * read by the client, which never walks the grid.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as publicEntry from './index.js';
import {
  admitDocument,
  displayRange,
  displayScale,
  evaluateSimulation,
  gridValues,
  parseBlock,
  parseDocument,
  validateDocument,
  walkBlocks,
  type ScrollDocument,
  type SimulationData,
  type SimulationDisplay,
} from './index.js';
import { compileDraft, validateDraft } from './producer/index.js';
import { simulationProof } from './simulation/checks.js';
import { displayIssues, placeholderDisplay, sameDisplay } from './simulation/display.js';
import { allFixtures, fixture } from './test-support/fixtures.js';
import { simulationData, withDisplay } from './test-support/arbitraries.js';

type Loose = Record<string, unknown>;

/** Each simulation of a document with the path of its block. */
function simulations(document: ScrollDocument): Array<{ data: SimulationData; id: string; path: string }> {
  return [...walkBlocks(document.sections)].flatMap(({ block, path }) =>
    block.type === 'simulation' ? [{ data: block.data, id: block.id, path }] : [],
  );
}

/** The display computed the long way: every grid point through the single-point evaluator. */
function bruteForce(data: Pick<SimulationData, 'params' | 'constants' | 'outputs' | 'view'>): SimulationDisplay {
  let points: Array<Record<string, number>> = [{}];
  for (const param of data.params) {
    const values = gridValues(param);
    points = points.flatMap((point) => values.map((value) => ({ ...point, [param.key]: value })));
  }
  const view = data.view;
  const wanted =
    view.kind === 'cards' ? view.items.map((item) => item.output) : view.kind === 'area' ? [view.area] : [];
  let largest = 0;
  let low = 0;
  let high = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const { outputs } = evaluateSimulation(data, point);
    for (const key of wanted) largest = Math.max(largest, outputs[key] ?? 0);
    if (view.kind === 'plot') {
      const value = outputs[view.y];
      if (value !== null && value !== undefined) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  if (view.kind === 'cards' || view.kind === 'area') return { kind: view.kind, scale: largest > 0 ? largest : 1 };
  if (view.kind === 'plot') return { kind: 'plot', range: high > low ? [low, high] : [low, low + 1] };
  return { kind: 'none' };
}

describe('admission computes the display scale from the grid', () => {
  it('equals the brute-force scale of every committed fixture simulation', () => {
    const found = allFixtures().flatMap((item) => simulations(item.document));
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const { data } of found) expect(data.display).toEqual(bruteForce(data));
  });

  it('equals the brute-force scale for any simulation that passes admission, whatever its view', () => {
    const kinds = new Set<string>();
    fc.assert(
      fc.property(simulationData, (data) => {
        fc.pre(publicEntry.simulationGridPoints(data) <= 300);
        const proof = simulationProof(data, '$');
        expect(proof.issues).toEqual([]);
        expect(proof.display).toEqual(bruteForce(data));
        expect(data.display).toEqual(proof.display);
        kinds.add(data.view.kind);
      }),
      { numRuns: 120 },
    );
    expect([...kinds].sort()).toEqual(['area', 'cards', 'plot', 'readout']);
  });

  it('is stored by compile, byte for byte what admission recomputes', () => {
    for (const item of allFixtures()) {
      const outcome = compileDraft(item.draft, item.provenance);
      if (outcome.kind !== 'compiled') throw new Error(JSON.stringify(outcome));
      for (const { data } of simulations(outcome.document)) {
        expect(data.display).toEqual(bruteForce(data));
        expect(data.display).not.toEqual(placeholderDisplay(data.view));
      }
      expect(admitDocument(outcome.document).kind).toBe('valid');
    }
  });
});

describe('the display is code-set data, never model-written', () => {
  it('is refused in a draft', () => {
    const item = fixture('weight-other-worlds');
    const draft = structuredClone(item.draft) as { sections: Array<{ blocks: Array<{ data: Loose }> }> };
    const data = draft.sections[0]?.blocks[0]?.data;
    if (data === undefined) throw new Error('fixture changed');
    data['display'] = { kind: 'cards', scale: 1 };
    expect(validateDraft(draft, item.provenance)).toMatchObject({
      kind: 'refused',
      stage: 'schema',
      issues: [{ code: 'schema_unrecognized_keys', path: 'sections.0.blocks.0.data' }],
    });
    expect(compileDraft(draft, item.provenance).kind).toBe('refused');
  });
});

describe('admission recomputes and compares the stored display; the hash covers it', () => {
  const weight = fixture('weight-other-worlds').document;
  const tamper = (change: (data: Loose) => void): unknown => {
    const copy = structuredClone(weight) as unknown as { sections: Array<{ blocks: Array<{ data: Loose }> }> };
    const data = copy.sections[0]?.blocks[0]?.data;
    if (data === undefined) throw new Error('fixture changed');
    change(data);
    return copy;
  };
  const scaleOf = (data: Loose) => (data['display'] as { scale: number }).scale;

  it('refuses a scale that is not the one the grid gives', () => {
    const doubled = tamper((data) => void (data['display'] = { kind: 'cards', scale: scaleOf(data) * 2 }));
    for (const outcome of [admitDocument(doubled), validateDocument(doubled)]) {
      expect(outcome).toMatchObject({
        kind: 'invalid',
        issues: [{ code: 'sim_display_mismatch', path: 'sections.0.blocks.0.data.display' }],
      });
    }
  });

  it('is covered by the integrity hash even where the proof tolerates the last digits', () => {
    const nudged = tamper((data) => void (data['display'] = { kind: 'cards', scale: scaleOf(data) * (1 + 1e-12) }));
    expect(admitDocument(nudged)).toMatchObject({ kind: 'invalid', issues: [{ code: 'integrity_mismatch' }] });
    expect(sameDisplay({ kind: 'cards', scale: 100 }, { kind: 'cards', scale: 100 * (1 + 1e-12) })).toBe(true);
    expect(sameDisplay({ kind: 'cards', scale: 100 }, { kind: 'area', scale: 100 })).toBe(false);
  });

  it('is part of the document: a tampered display with no recomputed hash changes the hash input', () => {
    const copy = structuredClone(weight);
    const sim = simulations(copy)[0];
    if (sim === undefined) throw new Error('fixture changed');
    expect(publicEntry.computeIntegrity(copy)).toBe(weight.integrity.sha256);
    sim.data.display = { kind: 'cards', scale: 1 };
    expect(publicEntry.computeIntegrity(copy)).not.toBe(weight.integrity.sha256);
  });
});

describe('the client path checks that the stored display is present and finite, and reads it', () => {
  const weight = fixture('weight-other-worlds').document;
  const documentWith = (display: unknown): unknown => {
    const copy = structuredClone(weight) as unknown as { sections: Array<{ blocks: Array<{ data: Loose }> }> };
    const data = copy.sections[0]?.blocks[0]?.data;
    if (data === undefined) throw new Error('fixture changed');
    if (display === undefined) delete data['display'];
    else data['display'] = display;
    return copy;
  };
  const codes = (input: unknown) => {
    const outcome = parseDocument(input);
    return outcome.kind === 'invalid' ? outcome.issues.map((issue) => issue.code) : [outcome.kind];
  };

  it('checks the rendition path the same way', () => {
    const bad = documentWith({ kind: 'cards', scale: 0 });
    for (const outcome of [validateDocument(bad, { purpose: 'rendition' }), parseDocument(bad)]) {
      expect(outcome).toMatchObject({ kind: 'invalid', issues: [{ code: 'sim_display_invalid' }] });
    }
  });

  it('refuses a missing display', () => {
    expect(codes(documentWith(undefined))).toEqual(['schema_invalid_type']);
  });

  it('refuses a display that is not finite, not positive, not increasing or of the wrong kind', () => {
    for (const display of [
      { kind: 'cards', scale: 0 },
      { kind: 'cards', scale: -5 },
      { kind: 'plot', range: [0, 1] },
      { kind: 'area', scale: 5 },
      { kind: 'none' },
    ]) {
      expect(codes(documentWith(display)), JSON.stringify(display)).toEqual(['sim_display_invalid']);
    }
    // Not finite, or beyond the ±1e15 every number of a document keeps to: the schema refuses them.
    expect(codes(documentWith({ kind: 'cards', scale: 1e16 }))).toEqual(['number_out_of_range']);
    expect(codes(documentWith({ kind: 'cards', scale: Number.POSITIVE_INFINITY }))).toEqual(['document_not_object']);
    // The wire never carries a non-finite number: a JSON round trip turns NaN into null.
    expect(codes(JSON.parse(JSON.stringify(documentWith({ kind: 'cards', scale: Number.NaN }))))).toEqual([
      'schema_invalid_type',
    ]);
  });

  it('displayIssues checks the kind against the view and the range against itself', () => {
    const sim = simulations(weight)[0];
    if (sim === undefined) throw new Error('fixture changed');
    const plot = { view: { kind: 'plot' as const, x: 'weightKg', y: 'moonKg', yLabel: 'Moon' } };
    expect(displayIssues({ view: sim.data.view, display: sim.data.display }, '$')).toEqual([]);
    expect(displayIssues({ ...plot, display: { kind: 'plot', range: [1, 1] } }, '$')).toHaveLength(1);
    expect(displayIssues({ ...plot, display: { kind: 'plot', range: [-2, 3] } }, '$')).toEqual([]);
    expect(displayIssues({ ...plot, display: { kind: 'cards', scale: 3 } }, '$')).toHaveLength(1);
  });

  it('does not recompute: a plausible stored display is trusted, which only admission can refute', () => {
    const doubled = documentWith({ kind: 'cards', scale: 1_012 });
    expect(parseDocument(doubled).kind).toBe('valid');
    expect(parseBlock((doubled as { sections: Array<{ blocks: unknown[] }> }).sections[0]?.blocks[0]).kind).toBe(
      'block',
    );
    expect(admitDocument(doubled).kind).toBe('invalid');
  });

  it('reads the stored scale and range, with a neutral value for a view that has none', () => {
    const cards = simulations(weight)[0];
    if (cards === undefined) throw new Error('fixture changed');
    expect(displayScale(cards.data)).toBe(505.99999999999994);
    expect(displayRange(cards.data)).toEqual([0, 1]);
    const square = {
      title: 'Square',
      params: [
        {
          key: 'x',
          label: 'X',
          min: -2,
          max: 3,
          step: 1,
          default: 0,
          control: 'slider' as const,
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      constants: [],
      outputs: [
        {
          key: 'y',
          label: 'Y',
          formula: { kind: 'product' as const, factors: ['x', 'x'] },
          format: { decimals: 0, grouping: false, approximate: false },
        },
      ],
      modelNote: 'A parabola for a test.',
      illustrative: { notice: 'Illustrative' as const },
    };
    const plot = withDisplay({ ...square, view: { kind: 'plot', x: 'x', y: 'y', yLabel: 'Y' } });
    expect(displayRange(plot)).toEqual([0, 9]);
    expect(displayScale(plot)).toBe(1);
    const area = withDisplay({
      ...square,
      view: { kind: 'area', length: 'x', area: 'y', lengthLabel: 'X', areaLabel: 'Y' },
    });
    expect(displayScale(area)).toBe(9);
    expect(displayRange(area)).toEqual([0, 1]);
    // A display of the wrong kind for its view is never read as if it fit.
    expect(displayScale({ view: plot.view, display: { kind: 'cards', scale: 7 } })).toBe(1);
    expect(displayRange({ view: area.view, display: { kind: 'plot', range: [3, 4] } })).toEqual([0, 1]);
  });
});

describe('the client entry point exposes nothing that walks the grid', () => {
  it('has no scale, range or sweep function; only the stored display readers', () => {
    const names = Object.keys(publicEntry);
    for (const forbidden of [
      'cardsScale',
      'plotRange',
      'sweepGrid',
      'simulationProof',
      'simulationIssues',
      'computeDisplay',
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect(names).toEqual(expect.arrayContaining(['displayScale', 'displayRange', 'parseBlock', 'parseDocument']));
  });
});
