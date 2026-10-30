import type { Loop, Puff } from '@knowscroll/scene-core';

/** A closed path for a set of loops, to be filled with the even-odd rule so a loop inside another is a hole. */
export function loopsToPath(loops: readonly Loop[]): string {
  let path = '';
  for (const loop of loops) {
    if (loop.length < 6) continue;
    path += `M${loop[0]} ${loop[1]}`;
    for (let at = 2; at < loop.length; at += 2) path += `L${loop[at]} ${loop[at + 1]}`;
    path += 'Z';
  }
  return path;
}

/**
 * A circle as two arcs, so a whole cloud is one path. Every shape of the path runs clockwise, so
 * overlapping lobes add up instead of cancelling into holes under the non-zero fill rule.
 */
const circle = (cx: number, cy: number, radius: number): string =>
  `M${(cx - radius).toFixed(1)} ${cy.toFixed(1)}a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 1 ${(radius * 2).toFixed(1)} 0a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 1 ${(-radius * 2).toFixed(1)} 0Z`;

/** A rounded bar as one path with arcs on both ends, also clockwise. */
function bar([x, y, width, height]: Puff['bar']): string {
  const round = height / 2;
  return `M${(x + round).toFixed(1)} ${y.toFixed(1)}h${(width - height).toFixed(1)}a${round.toFixed(1)} ${round.toFixed(1)} 0 0 1 0 ${height.toFixed(1)}h${(height - width).toFixed(1)}a${round.toFixed(1)} ${round.toFixed(1)} 0 0 1 0 ${(-height).toFixed(1)}Z`;
}

/** Every cloud of a set as one path: the round lobes and the flat base of each. */
export function puffsToPath(puffs: readonly Puff[]): string {
  let path = '';
  for (const puff of puffs) {
    for (let at = 0; at < puff.circles.length; at += 3)
      path += circle(puff.circles[at] ?? 0, puff.circles[at + 1] ?? 0, puff.circles[at + 2] ?? 0);
    path += bar(puff.bar);
  }
  return path;
}

/** An open ring arc of a planet's ring: the near half (front) or the far half (back), as an ellipse arc. */
export function ringArc(rx: number, ry: number, front: boolean): string {
  return front ? `M${-rx} 0A${rx} ${ry} 0 0 0 ${rx} 0` : `M${-rx} 0A${rx} ${ry} 0 0 1 ${rx} 0`;
}
