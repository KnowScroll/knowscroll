import {
  HAZE_FAMILY_NAMES,
  SCENE_FAMILY_NAMES,
  type HazeFamilyName,
  type LibrarySystem,
  type SceneFamilyName,
} from '../library/plan.js';
import { labelOfId } from './snapshot.js';
import type { NodeKind } from './types.js';

/**
 * A node as an author proposes it: the shape the library plan is imported as, and the shape a later growth step proposes
 * new topics in. It carries no revision number and no release: those are code's to assign when a release is made.
 */
export interface NodeDraft {
  readonly id: string;
  readonly kind: NodeKind;
  readonly parentId: string | null;
  readonly label: string;
  readonly meaning: string;
  /** Set on a system, and on a topic that overrides its system's; `null` otherwise. */
  readonly sceneFamily: SceneFamilyName | null;
  /** Set on a system only. */
  readonly haze: HazeFamilyName | null;
  /** The earlier wordings this meaning only rephrases (see {@link import('../library/plan.js').SameMeaning}). */
  readonly sameMeaningAs: readonly string[];
}

/** FNV-1a over UTF-16 code units: a small, stable hash that needs no library and never changes. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The haze a new system gets when its author names none: one of the six, picked from its id, so the same system always gets
 * the same haze and two systems may share one once the six are used (D-419). Assigned once, when the system is added.
 */
export const assignedHaze = (systemId: string): HazeFamilyName =>
  HAZE_FAMILY_NAMES[stableHash(`haze:${systemId}`) % HAZE_FAMILY_NAMES.length]!;

/** The silhouette family a new system gets when its author names none, picked from its id like its haze. */
export const assignedSceneFamily = (systemId: string): SceneFamilyName =>
  SCENE_FAMILY_NAMES[stableHash(`scene:${systemId}`) % SCENE_FAMILY_NAMES.length]!;

/**
 * The library plan as catalogue nodes, in the order they are first stored: each system, then each of its topics, each
 * followed by its facets. Existing ids stay as they are, so the plan's slugs are the nodes' stable ids. A label is made
 * from the id's last part, as the catalogue's labels always were.
 */
export function nodesOfPlan(systems: readonly LibrarySystem[]): readonly NodeDraft[] {
  return systems.flatMap((system): NodeDraft[] => [
    {
      id: system.id,
      kind: 'system',
      parentId: null,
      label: labelOfId(system.id),
      meaning: system.meaning,
      sceneFamily: system.sceneFamily ?? assignedSceneFamily(system.id),
      haze: system.haze ?? assignedHaze(system.id),
      sameMeaningAs: system.sameMeaningAs ?? [],
    },
    ...system.topics.flatMap((topic): NodeDraft[] => [
      {
        id: topic.id,
        kind: 'topic',
        parentId: system.id,
        label: labelOfId(topic.id),
        meaning: topic.meaning,
        sceneFamily: topic.sceneFamily ?? null,
        haze: null,
        sameMeaningAs: topic.sameMeaningAs ?? [],
      },
      ...topic.facets.map((facet): NodeDraft => ({
        id: facet.id,
        kind: 'facet',
        parentId: topic.id,
        label: labelOfId(facet.id),
        meaning: facet.meaning,
        sceneFamily: null,
        haze: null,
        sameMeaningAs: facet.sameMeaningAs ?? [],
      })),
    ]),
  ]);
}
