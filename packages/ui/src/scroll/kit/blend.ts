/**
 * Moving one picture of a kit to the next (D-133). The kits' scenes are flat records of numbers, a few
 * words and lists of numbers; a move inside one view blends the numbers and switches the words at the
 * middle. Nothing here knows a kit's physics: it only interpolates what the scene function derived.
 */

export const lerp = (from: number, to: number, progress: number): number => from + (to - from) * progress;

/** The shortest way round between two angles, so a Moon or a planet never travels the long way round. */
export function lerpAngle(from: number, to: number, progress: number): number {
  const difference = ((((to - from) % 360) + 540) % 360) - 180;
  return from + difference * progress;
}

/**
 * The scene `progress` of the way (0..1) from one scene to another of the same kit and view. Numbers
 * blend (a key named in `angles` by the shortest way round), lists of numbers of the same length blend
 * item by item, and everything else (words, lists of other things) is the later scene's from the middle on.
 */
export function blendScenes<Scene extends object>(
  from: Scene,
  to: Scene,
  progress: number,
  angles: readonly string[] = [],
): Scene {
  if (progress <= 0) return from;
  if (progress >= 1) return to;
  const earlier = from as Record<string, unknown>;
  const later = to as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(later)) {
    const before = earlier[key];
    const after = later[key];
    if (typeof before === 'number' && typeof after === 'number')
      result[key] = angles.includes(key) ? lerpAngle(before, after, progress) : lerp(before, after, progress);
    else if (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      after.every((item) => typeof item === 'number')
    )
      result[key] = after.map((item, index) => lerp(Number(before[index]), Number(item), progress));
    else result[key] = progress >= 0.5 ? after : before;
  }
  return result as Scene;
}
