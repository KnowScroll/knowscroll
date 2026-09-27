/**
 * #134 — one quiet line per atlas change (ADR-0036 §2; target 07 §4.2: "a chronicle line, not a
 * card"). Pure wording over the delta's own kind, cause and names; it never says anything about
 * the reader beyond what they did.
 */
import type { RelationKind } from './cartographer.ts';

const VERB: Record<RelationKind, string> = {
  explains: 'explains', prerequisite_for: 'comes before', contradicts: 'is in tension with',
  analogous_in: 'works like', applies_to: 'applies to', compares_mechanism: 'can be compared with',
};

export function relationPhrase(r: { kind: RelationKind; fromName: string; toName: string }): string {
  return `${r.fromName} ${VERB[r.kind]} ${r.toName}`;
}

export function chronicleLine(d: {
  kind: string; causalClass: string; name: string; parentName: string | null;
  relation: { kind: RelationKind; fromName: string; toName: string } | null;
  /** foundation_recognised: the names of the places it holds up. */
  holdsUp?: readonly string[];
}): string {
  switch (d.kind) {
    case 'place_formed':
      return d.parentName ? `${d.name} became a region of ${d.parentName}.` : `A place formed around ${d.name}.`;
    case 'sighting_appeared':
      return d.relation ? `${d.name} appeared near ${d.parentName ?? 'your places'}: ${relationPhrase(d.relation)}.` : `${d.name} appeared on the horizon.`;
    case 'sighting_retired':
      if (d.causalClass === 'source_correction') return `${d.name} left the horizon: what it was based on changed.`;
      if (d.causalClass === 'personal_exploration') return `You came across ${d.name}.`;
      return `${d.name} left the horizon.`;
    case 'place_rejected':
      return `You set ${d.name} aside.`;
    case 'place_released':
      return `${d.name} now stands on its own.`;
    case 'foundation_recognised':
      return `${d.name} holds up ${listNames(d.holdsUp ?? [])}.`;
    case 'foundation_withdrawn':
      return `${d.name} no longer holds up the places around it.`;
    default:
      return `${d.name} changed.`;
  }
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? 'the places around it';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
