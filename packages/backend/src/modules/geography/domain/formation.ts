import {
  MAX_PROPOSAL_OPERATIONS,
  formationEligible,
  proposalIssue,
  supportsFor,
  type FormationFacts,
  type GeographyProposal,
  type PlaceKind,
} from './policy.js';
import { activityChanges } from './quiet.js';

type Operation = GeographyProposal['operations'][number];
type CreationOperation = Extract<Operation, { key: string }>;

/** Parents come before children, so any prefix of the creations is a valid proposal on its own. */
const CREATION_ORDER: readonly PlaceKind[] = ['system', 'star', 'planet', 'region'];
const CREATION_KIND = {
  system: 'create_system',
  star: 'establish_star',
  planet: 'form_planet',
  region: 'add_region',
} as const satisfies Record<PlaceKind, CreationOperation['kind']>;

const isCreation = (operation: Operation): operation is CreationOperation => 'key' in operation;
const creationRank = (operation: CreationOperation) =>
  CREATION_ORDER.findIndex((kind) => CREATION_KIND[kind] === operation.kind);

/** The places the formation rules already entitle and that are not established yet. */
function dueCreations(facts: FormationFacts): CreationOperation[] {
  const known = new Set(facts.objects.map((place) => place.key));
  const candidates = [...facts.candidates].sort(
    (a, b) => CREATION_ORDER.indexOf(a.kind) - CREATION_ORDER.indexOf(b.kind),
  );
  const due: CreationOperation[] = [];
  for (const candidate of candidates) {
    const parentKnown = candidate.parentKey === 'universe' || known.has(candidate.parentKey);
    if (known.has(candidate.key) || !parentKnown) continue;
    const supports = supportsFor(facts, candidate);
    if (!formationEligible(facts, candidate, supports)) continue;
    known.add(candidate.key);
    due.push({
      kind: CREATION_KIND[candidate.kind],
      key: candidate.key,
      label: candidate.labels[0]!,
      truthStatus: 'factual',
      supportRefs: supports.map((support) => support.ref),
    });
  }
  return due;
}

/**
 * Whether the rules entitle a place that is not established yet. Only then is there anything for a
 * model to choose (a label, a route); without one a model call cannot change the outcome.
 */
export function placesDue(facts: FormationFacts): boolean {
  return dueCreations(facts).length > 0;
}

/**
 * Everything the rules already require, as one proposal: due places (parents first, canonical
 * catalogue labels), then due activity changes. Pure. The caller still validates and applies it
 * exactly as it would a model proposal.
 */
export function requiredChanges(facts: FormationFacts): GeographyProposal {
  const operations = [...dueCreations(facts), ...activityChanges(facts)].slice(0, MAX_PROPOSAL_OPERATIONS);
  return { version: 'cartographer-proposal.v1', operations };
}

/** What the rules decided to apply, and where it came from. */
export interface FormationPlan {
  readonly proposal: GeographyProposal;
  /** `model`: as proposed. `model_with_rules`: the model's proposal plus what the rules require.
   * `rules`: the rules alone, because there was no usable proposal or it conflicted with them. */
  readonly source: 'model' | 'model_with_rules' | 'rules';
}

/**
 * A model proposal together with every change the rules require that it left out, creations first
 * (parents before children) and the rest after, as the proposal that would be applied if they agree.
 * It is not validated here. The operations of `proposal` keep their identity, so a finding on the
 * merged list can be traced back to the model's own operation. Returns `proposal` itself when the
 * rules require nothing more.
 */
export function mergeWithRules(proposal: GeographyProposal, facts: FormationFacts): GeographyProposal {
  const required = requiredChanges(facts);
  const proposedPlaces = new Set(proposal.operations.filter(isCreation).map((operation) => operation.key));
  const proposedActivity = new Set(
    proposal.operations.flatMap((operation) => (operation.kind === 'set_activity' ? [operation.objectId] : [])),
  );
  const missing = required.operations.filter((operation) =>
    isCreation(operation)
      ? !proposedPlaces.has(operation.key)
      : operation.kind === 'set_activity' && !proposedActivity.has(operation.objectId),
  );
  if (!missing.length) return proposal;
  const all = [...proposal.operations, ...missing];
  return {
    ...proposal,
    operations: [
      ...all.filter(isCreation).sort((a, b) => creationRank(a) - creationRank(b)),
      ...all.filter((operation) => !isCreation(operation)),
    ],
  };
}

/**
 * A valid model proposal reconciled with what the rules require. Formation is decided by the rules,
 * never by a model's choice to omit something, so every required change the proposal left out is
 * added (places parents first). The model keeps what only it adds, such as routes and the choice
 * between canonical labels. When the combination conflicts (two operations on one place) or does
 * not fit one delta, the rules are applied alone, still validated like any proposal.
 */
export function reconcileWithRules(proposal: GeographyProposal, facts: FormationFacts): FormationPlan {
  const combined = mergeWithRules(proposal, facts);
  if (combined === proposal) return { proposal, source: 'model' };
  if (combined.operations.length <= MAX_PROPOSAL_OPERATIONS && !proposalIssue(combined, facts))
    return { proposal: combined, source: proposal.operations.length === 0 ? 'rules' : 'model_with_rules' };
  return { proposal: requiredChanges(facts), source: 'rules' };
}
