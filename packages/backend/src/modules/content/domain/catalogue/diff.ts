import type { NodeDraft } from './plan-import.js';
import type { ReleaseChange } from './release.js';
import type { CatalogueConcept, CatalogueSnapshot } from './snapshot.js';

/** What stands between the catalogue and an authored list of nodes. */
export interface PlanDifference {
  readonly changes: readonly ReleaseChange[];
  /** Nodes the catalogue holds and the list no longer names. They are reported, never retired: a missing line is not a decision. */
  readonly missingFromPlan: readonly string[];
}

const sameLook = (draft: NodeDraft, concept: CatalogueConcept) =>
  draft.sceneFamily === concept.sceneFamily && draft.haze === concept.haze;

/**
 * The changes that make the catalogue match an authored list of nodes (the library plan, today): a node the catalogue does
 * not hold is added, one whose label or meaning differs is revised, and everything that already matches is left alone, so
 * running it twice makes one release. Drafts are expected in plan order, parents before the nodes under them.
 */
export function changesToMatch(snapshot: CatalogueSnapshot, drafts: readonly NodeDraft[]): PlanDifference {
  const changes: ReleaseChange[] = [];
  const named = new Set<string>();
  for (const draft of drafts) {
    named.add(draft.id);
    if (draft.kind === 'facet') {
      const topic = draft.parentId === null ? undefined : snapshot.concept(draft.parentId);
      const facet = topic?.facets.find((candidate) => candidate.id === draft.id);
      if (facet === undefined) {
        // A facet the catalogue once retired is not added again: its id is never reused.
        if (!(topic !== undefined && snapshot.has(draft.id))) changes.push({ kind: 'add', draft });
      } else if (facet.label !== draft.label || facet.meaning !== draft.meaning)
        changes.push({ kind: 'revise', draft });
      continue;
    }
    const concept = snapshot.concept(draft.id);
    if (concept === undefined) {
      if (!snapshot.has(draft.id)) changes.push({ kind: 'add', draft });
    } else if (concept.retired) {
      continue;
    } else if (concept.label !== draft.label || concept.meaning !== draft.meaning || !sameLook(draft, concept)) {
      changes.push({ kind: 'revise', draft });
    }
  }
  const missingFromPlan = snapshot
    .all()
    .flatMap((concept) => [concept.id, ...concept.facets.map((facet) => facet.id)])
    .filter((id) => !named.has(id));
  return { changes, missingFromPlan };
}
