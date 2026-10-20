import type { SimulationData, SimulationDisplay } from '../blocks/simulation.js';
import { templateKeys } from '../blocks/simulation.js';
import type { Issue, ReasonCode } from '../issues.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import { placeholderDisplay } from './display.js';
import { formulaReferences, gridPositions, isOnGrid, simulationGridPoints, sweepGrid } from './evaluate.js';

type CheckedSimulation = Pick<SimulationData, 'params' | 'constants' | 'outputs' | 'view' | 'readout'>;

/** What the admission proof of one simulation found: the issues, and the display it proved. */
export interface SimulationProof {
  readonly issues: Issue[];
  /** The display scale computed in the same pass; null when the declarations or the proof failed. */
  readonly display: SimulationDisplay | null;
}

/**
 * ADMISSION: structural and computational checks of one simulation (`scroll-checks.v1`,
 * computation stage). Declarations are checked first (`simulationDeclarationIssues`). Only when
 * they are sound is every output evaluated at **every** point of the parameter grid (at most
 * `LIMITS.simulationGridPoints`, so this is a proof over the declared domain, not a sample; a
 * plot's curve samples are grid values): any non-finite or out-of-range output, and any negative
 * bar or area, refuses the simulation. The same pass finds the largest card or area value and the
 * range of the plotted output, which become the stored `display` (no second walk).
 *
 * Server, worker and producer only. A client must call `simulationDeclarationIssues` (or
 * `parseBlock`, which does): the grid proof costs milliseconds on a JIT and tens to hundreds of
 * milliseconds on Hermes, which has none (coordinator ruling on M1). Nothing a client calls walks
 * the grid.
 */
export function simulationProof(data: CheckedSimulation, path: string): SimulationProof {
  const declarations = simulationDeclarationIssues(data, path);
  if (declarations.length > 0) return { issues: declarations, display: null };
  const proof = gridProof(data);
  return {
    issues: proof.codes.map((code) => ({ code, path })),
    display: proof.codes.length === 0 ? proof.display : null,
  };
}

/** The issues of `simulationProof`. */
export function simulationIssues(data: CheckedSimulation, path: string): Issue[] {
  return simulationProof(data, path).issues;
}

/**
 * CLIENT AND ADMISSION: the cheap checks of one simulation, linear in what the block declares
 * (parameters, constants, outputs, their references, the view, the readout) and never in the size
 * of the grid. The grid itself is only counted (`sim_grid_too_large`), not walked.
 */
export function simulationDeclarationIssues(data: CheckedSimulation, path: string): Issue[] {
  const codes = new Set<ReasonCode>();
  const params = new Map(data.params.map((param) => [param.key, param]));
  const outputs = new Set(data.outputs.map((output) => output.key));
  const keys = [...data.params, ...data.constants, ...data.outputs].map((item) => item.key);
  if (new Set(keys).size !== keys.length) codes.add('sim_key_duplicate');

  for (const param of data.params) {
    const positions = gridPositions(param);
    const integral =
      Number.isFinite(positions) && Math.abs(positions - Math.round(positions)) <= 1e-9 * Math.max(1, positions);
    if (!(param.min < param.max) || !(param.step > 0) || !integral || positions > FIELD_LIMITS.sliderPositions) {
      codes.add('sim_param_range');
    } else if (!isOnGrid(param, param.default)) codes.add('sim_param_default');
  }
  if (!codes.has('sim_param_range') && simulationGridPoints(data) > LIMITS.simulationGridPoints)
    codes.add('sim_grid_too_large');

  const scope = new Set<string>([...params.keys(), ...data.constants.map((constant) => constant.key)]);
  for (const output of data.outputs) {
    if (formulaReferences(output.formula).some((key) => !scope.has(key))) codes.add('sim_reference_unknown');
    if (output.formula.kind === 'lookup') {
      const table = output.formula.table;
      if (table.some((entry, index) => index > 0 && !(entry.at > (table[index - 1]?.at ?? Number.POSITIVE_INFINITY)))) {
        codes.add('sim_lookup_table');
      }
    }
    scope.add(output.key);
  }

  const view = data.view;
  switch (view.kind) {
    case 'readout':
      if (!outputs.has(view.primary) || (view.secondary !== undefined && !outputs.has(view.secondary))) {
        codes.add('sim_view_invalid');
      }
      break;
    case 'cards':
      if (
        view.items.some((item) => !outputs.has(item.output)) ||
        new Set(view.items.map((item) => item.id)).size !== view.items.length
      ) {
        codes.add('sim_view_invalid');
      }
      break;
    case 'plot':
      if (!params.has(view.x) || !outputs.has(view.y)) codes.add('sim_view_invalid');
      break;
    case 'area':
      if (!params.has(view.length) || !outputs.has(view.area) || (params.get(view.length)?.min ?? -1) < 0) {
        codes.add('sim_view_invalid');
      }
      break;
  }

  if (data.readout !== undefined) {
    if (templateKeys(data.readout.template).some((key) => !scope.has(key))) codes.add('sim_template_key_unknown');
    for (const band of data.readout.bands) {
      if (!outputs.has(band.output)) codes.add('sim_band_invalid');
      if (band.min !== undefined && band.max !== undefined && !(band.min < band.max)) codes.add('sim_band_invalid');
    }
  }

  return [...codes].map((code) => ({ code, path }));
}

/**
 * Evaluates the whole grid (plot samples are grid values) once. Reports `sim_output_not_finite`
 * when any output is non-finite or beyond ±1e15 at any point, and `sim_view_out_of_range` when any
 * bar or area is negative at any point; the result does not depend on the order of the sweep. The
 * same pass finds the display scale: the largest card (or area) value, and the plotted output's
 * range, `[min(0, lowest), highest]`.
 */
function gridProof(data: CheckedSimulation): { codes: ReasonCode[]; display: SimulationDisplay } {
  const view = data.view;
  const positionOf = (key: string) => data.outputs.findIndex((output) => output.key === key);
  const barred =
    view.kind === 'cards'
      ? view.items.map((item) => positionOf(item.output))
      : view.kind === 'area'
        ? [positionOf(view.area)]
        : [];
  const plotted = view.kind === 'plot' ? positionOf(view.y) : -1;
  let notFinite = false;
  let negative = false;
  let largest = 0;
  let low = 0;
  let high = Number.NEGATIVE_INFINITY;
  sweepGrid(data, (row) => {
    if (!row.finite) notFinite = true;
    if (!negative && barred.some((position) => row.lowest(position) < 0)) negative = true;
    for (const position of barred) {
      const value = row.highest(position);
      if (value > largest) largest = value;
    }
    if (plotted >= 0) {
      const lowest = row.lowest(plotted);
      const highest = row.highest(plotted);
      if (lowest < low) low = lowest;
      if (highest > high) high = highest;
    }
    return !(notFinite && negative);
  });
  const codes: ReasonCode[] = [];
  if (notFinite) codes.push('sim_output_not_finite');
  if (negative) codes.push('sim_view_out_of_range');
  let display: SimulationDisplay = placeholderDisplay(view);
  if (view.kind === 'cards' || view.kind === 'area') display = { kind: view.kind, scale: largest > 0 ? largest : 1 };
  else if (view.kind === 'plot') display = { kind: 'plot', range: high > low ? [low, high] : [low, low + 1] };
  return { codes, display };
}
