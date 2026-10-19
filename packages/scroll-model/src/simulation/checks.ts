import type { SimulationData, SimulationParam } from '../blocks/simulation.js';
import { templateKeys } from '../blocks/simulation.js';
import type { Issue, ReasonCode } from '../issues.js';
import { FIELD_LIMITS } from '../limits.js';
import { evaluateSimulation, formulaReferences, gridPositions, isOnGrid, sampleCurve, snapToGrid } from './evaluate.js';

/**
 * Structural and computational checks of one simulation (`scroll-checks.v1`, computation stage).
 * Declarations are checked first; outputs are evaluated on a deterministic grid of parameter
 * values only when the declarations are sound, so evaluation never sees an unknown reference.
 */
export function simulationIssues(data: SimulationData, path: string): Issue[] {
  const codes = new Set<ReasonCode>();
  const params = new Map(data.params.map((param) => [param.key, param]));
  const constants = new Set(data.constants.map((constant) => constant.key));
  const outputs = new Set(data.outputs.map((output) => output.key));
  const keys = [...data.params, ...data.constants, ...data.outputs].map((item) => item.key);
  if (new Set(keys).size !== keys.length) codes.add('sim_key_duplicate');

  for (const param of data.params) {
    const positions = gridPositions(param);
    const integral = Math.abs(positions - Math.round(positions)) <= 1e-9 * Math.max(1, positions);
    if (!(param.min < param.max) || !(param.step > 0) || !integral || positions > FIELD_LIMITS.sliderPositions) {
      codes.add('sim_param_range');
    } else if (!isOnGrid(param, param.default)) codes.add('sim_param_default');
  }

  const scope = new Set<string>([...params.keys(), ...constants]);
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
        new Set(view.items.map((item) => item.id)).size !== view.items.length ||
        !(view.barMax > 0)
      ) {
        codes.add('sim_view_invalid');
      }
      break;
    case 'plot':
      if (!params.has(view.x) || !outputs.has(view.y) || !(view.yDomain[0] < view.yDomain[1])) {
        codes.add('sim_view_invalid');
      }
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

  if (codes.size === 0) for (const code of evaluationIssues(data)) codes.add(code);
  return [...codes].map((code) => ({ code, path }));
}

/** Values the validator tries for one parameter: min, max, default and up to eight grid points. */
function probeValues(param: SimulationParam): number[] {
  const positions = Math.round(gridPositions(param));
  const values = new Set<number>([param.min, param.max, param.default]);
  const count = Math.min(8, positions + 1);
  for (let index = 0; index < count; index += 1) {
    values.add(snapToGrid(param, param.min + param.step * Math.round((positions * index) / Math.max(1, count - 1))));
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Up to `FIELD_LIMITS.validationCombinations` parameter combinations, chosen deterministically:
 * the full product of probe values, thinned by a fixed stride when it is larger.
 */
export function validationCombinations(data: Pick<SimulationData, 'params'>): Array<Record<string, number>> {
  let combinations: Array<Record<string, number>> = [{}];
  for (const param of data.params) {
    const next: Array<Record<string, number>> = [];
    for (const combination of combinations) {
      for (const value of probeValues(param)) next.push({ ...combination, [param.key]: value });
    }
    combinations = next;
  }
  if (combinations.length <= FIELD_LIMITS.validationCombinations) return combinations;
  const stride = combinations.length / FIELD_LIMITS.validationCombinations;
  const thinned: Array<Record<string, number>> = [];
  for (let index = 0; index < FIELD_LIMITS.validationCombinations; index += 1) {
    const combination = combinations[Math.floor(index * stride)];
    if (combination !== undefined) thinned.push(combination);
  }
  const last = combinations[combinations.length - 1];
  if (last !== undefined && thinned[thinned.length - 1] !== last) thinned[thinned.length - 1] = last;
  return thinned;
}

function evaluationIssues(data: SimulationData): ReasonCode[] {
  const view = data.view;
  for (const combination of validationCombinations(data)) {
    const values = evaluateSimulation(data, combination);
    if (Object.values(values.outputs).some((value) => value === null)) return ['sim_output_not_finite'];
    if (view.kind === 'cards' && view.items.some((item) => (values.outputs[item.output] ?? -1) < 0)) {
      return ['sim_view_out_of_range'];
    }
    if (view.kind === 'area' && (values.outputs[view.area] ?? -1) < 0) return ['sim_view_out_of_range'];
    if (view.kind === 'plot') {
      for (const point of sampleCurve(data, combination, view.x, view.y)) {
        if (point.y === null) return ['sim_output_not_finite'];
        if (point.y < view.yDomain[0] - 1e-9 || point.y > view.yDomain[1] + 1e-9) return ['sim_plot_out_of_domain'];
      }
    }
  }
  return [];
}
