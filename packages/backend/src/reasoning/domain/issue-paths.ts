import { structureOf } from './schema-structure.js';

/**
 * Safe diagnostic paths for validator findings. A Zod issue path holds the keys of the rejected
 * answer, which a model chose and which can carry a secret or an instruction. The path printed in a
 * finding therefore uses only names the role's own schema declares, array and tuple positions the
 * schema proves, and the placeholders `[key]` (any record or map key) and `?` (anything unproved).
 */

/** A short plain token: safe to print whether it came from a schema or from Zod's own issue codes. */
export const safeSegment = /^[A-Za-z0-9_-]{1,32}$/;

/** What one path segment means in the schema: its label in the summary and the schema below it. */
interface Step {
  readonly label: string;
  readonly next: unknown;
}

/** Fixed diagnostic work bounds; exhaustion masks the remaining path, never widens validation. */
const PATH_LIMITS = { segments: 10, chars: 256, candidates: 64, depth: 16, visits: 512 } as const;
interface PathBudget {
  visits: number;
  exhausted: boolean;
}
const indexSegment = (segment: PropertyKey): segment is number =>
  typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0;

/** Keep every schema branch through shared prefixes. Never inspect the rejected value/discriminant. */
function stepsInto(
  candidates: readonly unknown[],
  segment: PropertyKey,
  first: boolean,
  budget: PathBudget,
): readonly Step[] {
  const pending = candidates.map((schema) => ({ schema, depth: 0 }));
  const seen = new Set<unknown>();
  const steps: Step[] = [];
  const push = (schema: unknown, depth: number) => {
    if (pending.length >= PATH_LIMITS.candidates || depth > PATH_LIMITS.depth) budget.exhausted = true;
    else pending.push({ schema, depth });
  };
  while (pending.length > 0 && !budget.exhausted) {
    const frame = pending.pop();
    if (frame === undefined || seen.has(frame.schema)) continue;
    seen.add(frame.schema);
    if (++budget.visits > PATH_LIMITS.visits) {
      budget.exhausted = true;
      break;
    }
    const structure = structureOf(frame.schema);
    if (structure === undefined) continue;
    const nextDepth = frame.depth + 1;
    switch (structure.kind) {
      case 'wrapper':
        push(structure.inner, nextDepth);
        break;
      case 'object':
        if (typeof segment === 'string' && safeSegment.test(segment) && Object.hasOwn(structure.shape, segment))
          steps.push({ label: first ? segment : `.${segment}`, next: structure.shape[segment] });
        break;
      case 'array':
        if (indexSegment(segment)) steps.push({ label: `[${segment}]`, next: structure.element });
        break;
      case 'tuple':
        if (indexSegment(segment))
          steps.push({ label: `[${segment}]`, next: structure.items[segment] ?? structure.rest });
        break;
      case 'keyed':
        steps.push({ label: '[key]', next: structure.value });
        break;
      case 'union':
        if (structure.options.length > PATH_LIMITS.candidates) budget.exhausted = true;
        else for (const option of structure.options) push(option, nextDepth);
        break;
      case 'intersection':
        push(structure.left, nextDepth);
        push(structure.right, nextDepth);
        break;
    }
    if (steps.length > PATH_LIMITS.candidates) budget.exhausted = true;
  }
  return budget.exhausted ? [] : steps;
}

/**
 * The printable form of an issue path, such as `sections[2].blocks[0].title`. Schema-owned names
 * only; unknown names and record/map keys stay masked under bounded traversal. With no schema, or
 * once a work bound is reached or the schema cannot be read, every remaining segment is `?`.
 */
export function pathOf(path: readonly PropertyKey[], schema?: unknown): string {
  if (path.length === 0) return '(root)';
  let candidates: readonly unknown[] = schema === undefined ? [] : [schema];
  const budget: PathBudget = { visits: 0, exhausted: false };
  let text = '';
  for (const [index, segment] of path.slice(0, PATH_LIMITS.segments).entries()) {
    let steps: readonly Step[] = [];
    try {
      steps = stepsInto(candidates, segment, index === 0, budget);
    } catch {
      budget.exhausted = true;
    }
    const labels = new Set(steps.map((step) => step.label));
    const label = labels.size === 1 ? steps[0]?.label : labels.has('[key]') ? '[key]' : undefined;
    // A number can be a model-chosen Map key. Only a proven array/tuple Step may print [n].
    const rendered = label ?? (index === 0 ? '?' : '.?');
    if (text.length + rendered.length > PATH_LIMITS.chars) break;
    text += rendered;
    candidates = budget.exhausted ? [] : [...new Set(steps.map((step) => step.next))];
  }
  return text;
}
