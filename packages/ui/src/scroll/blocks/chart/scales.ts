import { formatNumber } from '../../model';

export interface Scale {
  /** Where a data value falls between 0 (the start of the axis) and 1 (its end). */
  readonly at: (value: number) => number;
  readonly domain: readonly [number, number];
  readonly ticks: readonly number[];
  readonly scale: 'linear' | 'log';
}

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const nice = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10;
  return nice * magnitude;
}

/** The smallest round-number range that holds `low` to `high`. */
function niceDomain(low: number, high: number): [number, number] {
  const step = niceStep(high - low, 5);
  return [Math.floor(low / step + 1e-9) * step, Math.ceil(high / step - 1e-9) * step];
}

/** Round-number ticks inside a domain: about `target` of them. */
export function linearTicks(low: number, high: number, target = 5): number[] {
  if (!(high > low)) return [low];
  const step = niceStep(high - low, target);
  const first = Math.ceil(low / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= high + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
    if (ticks.length > 20) break;
  }
  return ticks;
}

/** Powers of ten inside a positive domain. */
export function logTicks(low: number, high: number): number[] {
  const ticks: number[] = [];
  for (let exponent = Math.ceil(Math.log10(low)); 10 ** exponent <= high * (1 + 1e-9); exponent += 1) {
    ticks.push(10 ** exponent);
    if (ticks.length > 20) break;
  }
  return ticks.length > 0 ? ticks : [low, high];
}

/**
 * A scale for an axis. An authored `domain` is used as given; otherwise the data's own range,
 * widened to include zero for a linear axis of bars (`includeZero`) and to a little padding for a
 * line. A log axis needs a positive domain (the package refuses anything else).
 */
export function makeScale(
  values: readonly number[],
  axis: { scale: 'linear' | 'log'; domain?: readonly [number, number] | undefined },
  options: { includeZero?: boolean } = {},
): Scale {
  let low = Math.min(...values);
  let high = Math.max(...values);
  if (axis.domain !== undefined) [low, high] = axis.domain;
  else if (axis.scale === 'linear') {
    if (options.includeZero === true) {
      low = Math.min(0, low);
      high = Math.max(0, high);
    }
    if (!(high > low)) high = low + 1;
    [low, high] = niceDomain(low, high);
  } else {
    // A log axis runs between powers of ten, so a bar or a point is never at the very edge.
    low = 10 ** Math.floor(Math.log10(low) + 1e-9);
    high = 10 ** Math.ceil(Math.log10(high) - 1e-9);
    if (!(high > low)) high = low * 10;
  }
  if (axis.scale === 'log') {
    const logLow = Math.log10(low);
    const logHigh = Math.log10(high);
    return {
      at: (value) => (Math.log10(Math.max(value, low)) - logLow) / (logHigh - logLow || 1),
      domain: [low, high],
      ticks: logTicks(low, high),
      scale: 'log',
    };
  }
  const span = high - low || 1;
  return { at: (value) => (value - low) / span, domain: [low, high], ticks: linearTicks(low, high), scale: 'linear' };
}

/** A tick label: grouped, at most two decimals, no trailing zeros. */
export function tickLabel(value: number): string {
  const decimals = Number.isInteger(value) ? 0 : Math.abs(value) < 1 ? 2 : 1;
  return formatNumber(Number(value.toFixed(decimals)), {
    decimals: Math.min(decimals, 2),
    grouping: true,
    approximate: false,
  });
}
