import { snapToGrid, type SimulationParam } from '../../model';

/** Where a value sits along a parameter's range, 0 at the minimum and 1 at the maximum. */
export function ratioOf(param: SimulationParam, value: number): number {
  const span = param.max - param.min;
  return span > 0 ? Math.min(1, Math.max(0, (value - param.min) / span)) : 0;
}

/** The nearest grid value for a position along the range (0..1): readers can only set values on the grid. */
export function valueAt(param: SimulationParam, ratio: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return snapToGrid(param, param.min + clamped * (param.max - param.min));
}

/** `steps` grid steps up (or down, when negative) from `value`, kept on the grid and inside the range. */
export function stepped(param: SimulationParam, value: number, steps: number): number {
  return snapToGrid(param, value + steps * param.step);
}

/** A page key moves by a tenth of the range, at least one step. */
function pageSteps(param: SimulationParam): number {
  const positions = Math.round((param.max - param.min) / param.step);
  return Math.max(1, Math.round(positions / 10));
}

/**
 * What a key does to a slider (the WAI-ARIA slider pattern, E03): arrows change it by one step,
 * Page Up and Page Down by a page, Home and End jump to the ends. Null for any other key.
 */
export function valueForKey(param: SimulationParam, value: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return stepped(param, value, 1);
    case 'ArrowLeft':
    case 'ArrowDown':
      return stepped(param, value, -1);
    case 'PageUp':
      return stepped(param, value, pageSteps(param));
    case 'PageDown':
      return stepped(param, value, -pageSteps(param));
    case 'Home':
      return param.min;
    case 'End':
      return param.max;
    default:
      return null;
  }
}

/**
 * A number typed into an input control, read the way a reader writes it ("4,096", "60 kg", "−3"):
 * digits, one decimal point, an optional minus. Null when there is no number in it.
 */
export function parseTyped(text: string): number | null {
  const cleaned = text.replace(/[,\s]/gu, '').replace(/[−–]/gu, '-');
  const match = /^-?\d+(?:\.\d+)?|^-?\.\d+/u.exec(cleaned);
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}
