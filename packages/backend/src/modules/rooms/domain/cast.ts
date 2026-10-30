/** The cast of a room: the named residents that live in it (D-163). No database, clock or model. */
import type { InhabitantId } from './contribution.js';

/** One resident of a room: the role it plays and the name it goes by. Names come from this catalogue, never from a model. */
export interface CastMember {
  readonly inhabitant: InhabitantId;
  readonly name: string;
}

/**
 * Who lives in every room until a room has a face of its own (R-4): the Explainer Nova and the Skeptic Halley, the
 * names the T3 design gives its residents. The Quizmaster (Pixel) arrives with the Launch.
 */
export const DEFAULT_CAST: readonly CastMember[] = [
  { inhabitant: 'explainer', name: 'Nova' },
  { inhabitant: 'skeptic', name: 'Halley' },
];

/** A room has two to four residents: an Explainer and a Skeptic always, and at most four in all (T3 question 10, R3). */
export const CAST_MIN = 2;
export const CAST_MAX = 4;

export type CastProblem = 'too_small' | 'too_large' | 'missing_role' | 'repeated_role' | 'repeated_name' | 'bad_name';

/** Whether a cast is one a room may have. A resident is never shown without a plain name. */
export function castProblem(cast: readonly CastMember[]): CastProblem | undefined {
  if (cast.length < CAST_MIN) return 'too_small';
  if (cast.length > CAST_MAX) return 'too_large';
  const roles = new Set(cast.map((member) => member.inhabitant));
  if (roles.size !== cast.length) return 'repeated_role';
  if (!roles.has('explainer') || !roles.has('skeptic')) return 'missing_role';
  const names = cast.map((member) => member.name.trim());
  if (names.some((name) => name === '' || [...name].length > 24)) return 'bad_name';
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) return 'repeated_name';
  return undefined;
}

/** The name a resident goes by in this cast, or its role word when the cast has no such resident. */
export function nameOf(cast: readonly CastMember[], inhabitant: InhabitantId): string {
  return cast.find((member) => member.inhabitant === inhabitant)?.name ?? inhabitant;
}
