import type { SimulationData, SimulationDisplay, SimulationView } from '../blocks/simulation.js';
import type { Issue } from '../issues.js';

/**
 * The stored display scale of a simulation (`SimulationData.display`): the pure, grid-free part.
 * Admission computes the values (`simulation/checks.ts`, in the same pass that proves the outputs
 * finite); everything here only reads, compares or validates what was stored, so a client may call
 * all of it.
 */

type WithDisplay = Pick<SimulationData, 'view' | 'display'>;

/** The `display.kind` a view needs. */
export function displayKindOf(view: Pick<SimulationView, 'kind'>): SimulationDisplay['kind'] {
  switch (view.kind) {
    case 'readout':
      return 'none';
    case 'cards':
      return 'cards';
    case 'area':
      return 'area';
    case 'plot':
      return 'plot';
  }
}

/**
 * A well-formed display that carries no information, for a block whose real display is not known
 * yet: the producer assembles with it and replaces it with the proven one before the document is
 * signed; admission refuses a stored document whose display does not equal the proven one.
 */
export function placeholderDisplay(view: Pick<SimulationView, 'kind'>): SimulationDisplay {
  switch (view.kind) {
    case 'readout':
      return { kind: 'none' };
    case 'cards':
      return { kind: 'cards', scale: 1 };
    case 'area':
      return { kind: 'area', scale: 1 };
    case 'plot':
      return { kind: 'plot', range: [0, 1] };
  }
}

/**
 * CLIENT: the bar or square scale stored by admission (`cards` and `area` views); 1 for any other
 * view. It is read, never computed: nothing here walks the grid. A value the client's own
 * arithmetic puts a hair above the scale (engines may round the last digit differently) is
 * clamped by the renderer.
 */
export function displayScale(data: WithDisplay): number {
  const display = data.display;
  return (display.kind === 'cards' || display.kind === 'area') && display.kind === data.view.kind ? display.scale : 1;
}

/** CLIENT: the y range stored by admission for a `plot` view; `[0, 1]` for any other view. Never walks the grid. */
export function displayRange(data: WithDisplay): readonly [number, number] {
  const display = data.display;
  return display.kind === 'plot' && data.view.kind === 'plot' ? display.range : [0, 1];
}

/**
 * Cheap, grid-free checks of the stored display, on both paths: it must be the kind its view
 * needs, and finite with a positive scale or an increasing range (presence and finiteness are
 * also enforced by the schema).
 */
export function displayIssues(data: WithDisplay, path: string): Issue[] {
  const display = data.display;
  const valid =
    display.kind === displayKindOf(data.view) &&
    (display.kind === 'none' ||
      (display.kind === 'plot'
        ? Number.isFinite(display.range[0]) && Number.isFinite(display.range[1]) && display.range[0] < display.range[1]
        : Number.isFinite(display.scale) && display.scale > 0));
  return valid ? [] : [{ code: 'sim_display_invalid', path: `${path}.display` }];
}

const TOLERANCE = 1e-9;

/**
 * True when two displays are the same up to the last digits: within a relative 1e-9 of their own
 * magnitude (a scale against the larger scale; a range's two ends against the largest end, so a
 * low end that is zero on one engine and a rounding error on another still agrees). The proven
 * display is recomputed at admission on whatever engine the server runs, and a stored one must
 * not be refused because a library update changed the final digit of a power. There is no
 * absolute floor: a wrong scale of a simulation whose outputs are tiny (1e-10) is refused too.
 */
export function sameDisplay(a: SimulationDisplay, b: SimulationDisplay): boolean {
  if (a.kind === 'none') return b.kind === 'none';
  if (a.kind === 'plot') {
    if (b.kind !== 'plot') return false;
    const allowed = TOLERANCE * Math.max(...a.range.map(Math.abs), ...b.range.map(Math.abs));
    return Math.abs(a.range[0] - b.range[0]) <= allowed && Math.abs(a.range[1] - b.range[1]) <= allowed;
  }
  return b.kind === a.kind && Math.abs(a.scale - b.scale) <= TOLERANCE * Math.max(Math.abs(a.scale), Math.abs(b.scale));
}

/**
 * CLIENT: where `value` stands in the stored display, always a finite number from 0 to 1: a
 * card's or an area's fraction of its scale, or a plotted value's place in the stored range.
 * Anything that is not finite (a guarded `null`, or a quotient of a forged scale) reads as 0 or 1,
 * never as `NaN` or `Infinity`, so a renderer can use it as a length without a further guard.
 */
export function displayFraction(value: number | null, data: WithDisplay): number {
  if (value === null || !Number.isFinite(value)) return 0;
  const display = data.display;
  let fraction: number;
  if ((display.kind === 'cards' || display.kind === 'area') && display.kind === data.view.kind)
    fraction = value / display.scale;
  else if (display.kind === 'plot' && data.view.kind === 'plot')
    fraction = (value - display.range[0]) / (display.range[1] - display.range[0]);
  else return 0;
  return Number.isNaN(fraction) ? 0 : Math.min(1, Math.max(0, fraction));
}
