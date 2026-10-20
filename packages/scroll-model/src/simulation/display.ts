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
const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * True when two displays are the same up to the last digits (relative 1e-9): the proven display
 * is recomputed at admission on whatever engine the server runs, and a stored one must not be
 * refused because a library update changed the final digit of a power.
 */
export function sameDisplay(a: SimulationDisplay, b: SimulationDisplay): boolean {
  if (a.kind === 'none') return b.kind === 'none';
  if (a.kind === 'plot') return b.kind === 'plot' && close(a.range[0], b.range[0]) && close(a.range[1], b.range[1]);
  return b.kind === a.kind && close(a.scale, b.scale);
}
