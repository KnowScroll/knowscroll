import type { SimulationData } from '../blocks/simulation.js';
import { templateKeys } from '../blocks/simulation.js';
import type { Issue, ReasonCode } from '../issues.js';
import { FIELD_LIMITS, LIMITS } from '../limits.js';
import {
  compileSimulation,
  forEachGridPoint,
  formulaReferences,
  gridPositions,
  isOnGrid,
  simulationGridPoints,
} from './evaluate.js';

type CheckedSimulation = Pick<SimulationData, 'params' | 'constants' | 'outputs' | 'view' | 'readout'>;

/**
 * Structural and computational checks of one simulation (`scroll-checks.v1`, computation stage).
 * Declarations are checked first. Only when they are sound is every output evaluated at **every**
 * point of the parameter grid (at most `LIMITS.simulationGridPoints`, so this is a proof over the
 * declared domain, not a sample) and, for a plot, at every curve sample: any non-finite or
 * out-of-range output, and any negative bar or area, refuses the simulation.
 */
export function simulationIssues(data: CheckedSimulation, path: string): Issue[] {
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

  if (codes.size === 0) for (const code of gridIssues(data)) codes.add(code);
  return [...codes].map((code) => ({ code, path }));
}

/** Evaluates the whole grid (and every plot sample); stops at the first failure. */
function gridIssues(data: CheckedSimulation): ReasonCode[] {
  const compiled = compileSimulation(data);
  const view = data.view;
  const outputPosition = (key: string) => data.outputs.findIndex((output) => output.key === key);
  const nonNegative =
    view.kind === 'cards'
      ? view.items.map((item) => compiled.outputSlots[outputPosition(item.output)] ?? -1)
      : view.kind === 'area'
        ? [compiled.outputSlots[outputPosition(view.area)] ?? -1]
        : [];
  let failure: ReasonCode | null = null;
  forEachGridPoint(
    data,
    (state) => {
      for (const slot of state.outputSlots) {
        if (Number.isNaN(state.slots[slot] ?? Number.NaN)) {
          failure = 'sim_output_not_finite';
          return false;
        }
      }
      for (const slot of nonNegative) {
        if ((state.slots[slot] ?? -1) < 0) {
          failure = 'sim_view_out_of_range';
          return false;
        }
      }
      return true;
    },
    view.kind === 'plot' ? { plotX: view.x } : {},
  );
  return failure === null ? [] : [failure];
}
