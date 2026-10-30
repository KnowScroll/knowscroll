import type { Stream } from './random.js';
import type { Puff } from './types.js';

const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * A cartoon cloud centred on a point: four to six round lobes along a flat base. Placed in world
 * units already, so a renderer only draws circles and a rounded bar. Each lobe takes three numbers
 * from the stream, so a cloud is the same on every engine.
 */
export function makePuff(stream: Stream, x: number, y: number, scale: number): Puff {
  const lobes = 4 + Math.floor(stream() * 3);
  const raw: number[] = [];
  let run = 0;
  for (let lobe = 0; lobe < lobes; lobe++) {
    const radius = 13 + stream() * 13;
    raw.push(run, -radius * 0.42 + stream() * 4, radius);
    run += radius * (0.75 + stream() * 0.35);
  }
  const flip = stream() < 0.5 ? -1 : 1;
  const circles: number[] = [];
  for (let at = 0; at < raw.length; at += 3) {
    circles.push(
      tenth(x + ((raw[at] ?? 0) - run / 2) * scale * flip),
      tenth(y + (raw[at + 1] ?? 0) * scale),
      tenth((raw[at + 2] ?? 0) * scale),
    );
  }
  return {
    circles,
    bar: [tenth(x - (run / 2 + 8) * scale), tenth(y - 12 * scale), tenth((run + 16) * scale), tenth(24 * scale)],
  };
}
