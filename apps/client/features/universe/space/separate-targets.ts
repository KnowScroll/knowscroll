/** A square tap target centred on a body of the scene. */
export interface TargetBox {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** The side the body would like: a finger-sized square, or larger for a big sun. */
  readonly size: number;
}

/** The smallest side a target is shrunk to when bodies crowd it (WCAG 2.5.8). */
export const CROWDED_TARGET = 24;

const PASSES = 4;

const reach = (first: TargetBox, second: TargetBox): number =>
  Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));

/**
 * Keeps tap targets from covering each other. Bodies orbit and can pass close by, and a target that
 * another one covers is no longer a target. Two overlapping squares both shrink, in proportion, until
 * they touch, never below {@link CROWDED_TARGET}. If their centres are closer than that, the hit areas
 * (not the drawing) are moved apart along the longer gap. Pure: the same boxes always give the same answer,
 * in the same order.
 */
export function separateTargets(boxes: readonly TargetBox[]): readonly TargetBox[] {
  const out = boxes.map((box) => ({ ...box }));
  for (let pass = 0; pass < PASSES; pass++) {
    for (let first = 0; first < out.length; first++) {
      for (let second = first + 1; second < out.length; second++) {
        const one = out[first]!;
        const other = out[second]!;
        const gap = reach(one, other);
        if (gap >= (one.size + other.size) / 2) continue;
        const scale = (2 * gap) / (one.size + other.size);
        one.size = Math.max(CROWDED_TARGET, one.size * scale);
        other.size = Math.max(CROWDED_TARGET, other.size * scale);
        const needed = (one.size + other.size) / 2;
        if (gap >= needed) continue;
        const sideways = Math.abs(one.x - other.x) >= Math.abs(one.y - other.y);
        const push = (needed - gap) / 2;
        const direction = (sideways ? other.x - one.x : other.y - one.y) >= 0 ? 1 : -1;
        if (sideways) {
          one.x -= direction * push;
          other.x += direction * push;
        } else {
          one.y -= direction * push;
          other.y += direction * push;
        }
      }
    }
  }
  return out;
}
