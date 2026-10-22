import { checkErasureInventory } from './infrastructure/erasure/inventory.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from './infrastructure/receipts/canonical.js';
import { RECORDING_LIFECYCLE_PROTOCOL_SHA256, type ClearCoreTx } from './modules/identity/public.js';
import { eraseExploration, type ModuleErasure } from './infrastructure/erasure/registry.js';
import { markCurrentClearRemovalVerified, clearCoreTransactionOf } from './infrastructure/postgres/privacy-scope.js';
import { socialErasure } from './modules/social/adapters/erasure.js';
import { scenesErasure } from './modules/scenes/adapters/erasure.js';
import { geographyErasure } from './modules/geography/adapters/erasure.js';
import { supplyErasure } from './modules/supply/adapters/erasure.js';
import { plannerErasure } from './modules/planner/adapters/erasure.js';
import { clearExplorationRegistry, erasureRegistry } from './infrastructure/erasure/registry.js';
import { composerErasure } from './modules/composer/adapters/erasure.js';
import { evidenceErasure } from './modules/evidence/adapters/erasure.js';
import { personalContextErasure } from './modules/personal-context/adapters/erasure.js';
import { experienceErasure } from './modules/experience/adapters/erasure.js';
import { identityErasure } from './modules/identity/adapters/erasure.js';
import { reasoningErasure } from './reasoning/adapters/erasure.js';
import { receiptsErasure } from './infrastructure/receipts/erasure.js';

/**
 * Every personal store in the backend, in eraser order (rows that reference others first). The
 * schema inventory test fails when a table with a `universe_id` column is missing here.
 *
 * Identity is listed last: its account-keyed tables (addresses, sign-in links, sessions) are
 * erased by account deletion, not by clearing a universe, and the inventory test fails when an
 * identity table is not declared. Not listed because they hold no personal rows of their own:
 * `identity.accounts`/`identity.universes` (the personal root itself; account deletion is its own
 * lifecycle) and `content.assets` (shared content).
 */
export const personalStores = erasureRegistry([
  socialErasure,
  scenesErasure,
  geographyErasure,
  supplyErasure,
  plannerErasure,
  personalContextErasure,
  evidenceErasure,
  experienceErasure,
  composerErasure,
  reasoningErasure,
  receiptsErasure,
  identityErasure,
]);

/** Explicit order, with Social and Identity preserved. No full-eraser callback is used. */
const preservedSocial = {
  ...socialErasure,
  clearExploration: {
    dispositions: Object.fromEntries([
      ...socialErasure.tables.map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...(socialErasure.accountTables ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...(socialErasure.accountColumns ?? []).map((t) => [`${t.schema}.${t.table}`, 'preserve']),
      ...socialErasure.nonRowStores.map((s) => [`store:${s.name}`, 'preserve']),
    ]) as Record<string, 'preserve'>,
    erase: () => Promise.resolve({ module: 'social', status: 'completed' as const, removed: 0 }),
  },
};
export const explorationStores = clearExplorationRegistry(
  [
    preservedSocial,
    scenesErasure,
    geographyErasure,
    supplyErasure,
    plannerErasure,
    personalContextErasure,
    evidenceErasure,
    experienceErasure,
    composerErasure,
    reasoningErasure,
    receiptsErasure,
    identityErasure,
  ],
  personalStores,
  async (scope) => (await checkErasureInventory(clearCoreTransactionOf(scope), personalStores)).length === 0,
);

/** Immutable literal protocol, independent of code/SQL hashes. Changing any participating writer
 * or clear disposition needs a new reviewed protocol; no runtime caller supplies a manifest. */
const currentRecordingProtocol = {
  protocol: 'fresh-recording-lifecycle.v1',
  version: 1,
  registry: [
    {
      module: 'social',
      personalTables: [],
      accountTables: [
        {
          table: 'social.roster_heads',
          ownerColumn: 'owner_account_id',
        },
        {
          table: 'social.roster_entries',
          ownerColumn: 'owner_account_id,peer_account_id',
        },
        {
          table: 'social.invites',
          ownerColumn: 'account_id',
        },
        {
          table: 'social.profiles',
          ownerColumn: 'account_id',
        },
        {
          table: 'social.pairs',
          ownerColumn: 'low_account_id,high_account_id',
        },
        {
          table: 'social.pair_sides',
          ownerColumn: 'account_id',
        },
        {
          table: 'social.requests',
          ownerColumn: 'sender_account_id,recipient_account_id',
        },
        {
          table: 'social.command_bindings',
          ownerColumn: 'actor_account_id',
        },
      ],
      accountColumns: [
        {
          table: 'social.roster_heads',
          column: 'owner_account_id',
        },
        {
          table: 'social.roster_entries',
          column: 'owner_account_id',
        },
        {
          table: 'social.roster_entries',
          column: 'peer_account_id',
        },
        {
          table: 'social.invites',
          column: 'account_id',
        },
        {
          table: 'social.profiles',
          column: 'account_id',
        },
        {
          table: 'social.pairs',
          column: 'low_account_id',
        },
        {
          table: 'social.pairs',
          column: 'high_account_id',
        },
        {
          table: 'social.pair_sides',
          column: 'account_id',
        },
        {
          table: 'social.requests',
          column: 'sender_account_id',
        },
        {
          table: 'social.requests',
          column: 'recipient_account_id',
        },
        {
          table: 'social.command_bindings',
          column: 'actor_account_id',
        },
      ],
      nonRowStores: [],
      clearDispositions: {
        'social.roster_heads': 'preserve',
        'social.roster_entries': 'preserve',
        'social.invites': 'preserve',
        'social.profiles': 'preserve',
        'social.pairs': 'preserve',
        'social.pair_sides': 'preserve',
        'social.requests': 'preserve',
        'social.command_bindings': 'preserve',
      },
    },
    {
      module: 'scenes',
      personalTables: [
        {
          table: 'scenes.formation_presentations',
          ownerColumn: 'universe_id',
        },
        {
          table: 'scenes.manifests',
          ownerColumn: 'universe_id',
        },
        {
          table: 'scenes.chunks',
          ownerColumn: 'universe_id',
        },
        {
          table: 'scenes.objects',
          ownerColumn: 'universe_id',
        },
        {
          table: 'scenes.state',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: ['pgboss/scenes.recover-formation', 'pgboss/scenes.expire-formation', 'pgboss/scenes.project'],
      clearDispositions: {
        'scenes.formation_presentations': 'erase',
        'scenes.manifests': 'erase',
        'scenes.chunks': 'erase',
        'scenes.objects': 'erase',
        'scenes.state': 'erase',
        'store:pgboss/scenes.recover-formation': 'preserve',
        'store:pgboss/scenes.expire-formation': 'erase',
        'store:pgboss/scenes.project': 'erase',
      },
    },
    {
      module: 'geography',
      personalTables: [
        {
          table: 'geography.deltas',
          ownerColumn: 'universe_id',
        },
        {
          table: 'geography.relations',
          ownerColumn: 'universe_id',
        },
        {
          table: 'geography.objects',
          ownerColumn: 'universe_id',
        },
        {
          table: 'geography.state',
          ownerColumn: 'universe_id',
        },
        {
          table: 'geography.runs',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [{ table: 'geography.runs', column: 'recording_account_id' }],
      nonRowStores: ['pgboss/geography.cartograph', 'pgboss/geography.publish-delta'],
      clearDispositions: {
        'geography.deltas': 'erase',
        'geography.relations': 'erase',
        'geography.objects': 'erase',
        'geography.state': 'erase',
        'geography.runs': 'erase',
        'store:pgboss/geography.cartograph': 'erase',
        'store:pgboss/geography.publish-delta': 'erase',
      },
    },
    {
      module: 'supply',
      personalTables: [
        {
          table: 'supply.requests',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: ['pgboss/supply.resolve-request'],
      clearDispositions: {
        'supply.requests': 'erase',
        'store:pgboss/supply.resolve-request': 'erase',
      },
    },
    {
      module: 'planner',
      personalTables: [
        {
          table: 'planner.revisions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'planner.state',
          ownerColumn: 'universe_id',
        },
        {
          table: 'planner.runs',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [{ table: 'planner.runs', column: 'recording_account_id' }],
      nonRowStores: ['pgboss/planner.run'],
      clearDispositions: {
        'planner.revisions': 'erase',
        'planner.state': 'erase',
        'planner.runs': 'erase',
        'store:pgboss/planner.run': 'erase',
      },
    },
    {
      module: 'personal-context',
      personalTables: [
        {
          table: 'personal_context.recording_coverage_references',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.recording_coverage_contributions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.recording_exposure_contributions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.recording_segment_heads',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.coverage_references',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.coverage_supports',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.coverage_contributions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.contributions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.supports',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.topics',
          ownerColumn: 'universe_id',
        },
        {
          table: 'personal_context.state',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: [],
      clearDispositions: {
        'personal_context.recording_coverage_references': 'erase',
        'personal_context.recording_coverage_contributions': 'erase',
        'personal_context.recording_exposure_contributions': 'erase',
        'personal_context.recording_segment_heads': 'erase',
        'personal_context.coverage_references': 'erase',
        'personal_context.coverage_supports': 'erase',
        'personal_context.coverage_contributions': 'erase',
        'personal_context.contributions': 'erase',
        'personal_context.supports': 'erase',
        'personal_context.topics': 'erase',
        'personal_context.state': 'erase',
      },
    },
    {
      module: 'evidence',
      personalTables: [
        {
          table: 'evidence.recording_exposure_credit',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.recording_segment_heads',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.recording_sessions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.topic_contributions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.activity_current',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.activity_revisions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.topic_context',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.encounter_evidence',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.observations',
          ownerColumn: 'universe_id',
        },
        {
          table: 'evidence.action_events',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: [
        'pgboss/evidence.apply-action',
        'pgboss/evidence.project-scroll-reading',
        'pgboss/evidence.project-encounter-activity',
      ],
      clearDispositions: {
        'evidence.recording_exposure_credit': 'erase',
        'evidence.recording_segment_heads': 'erase',
        'evidence.recording_sessions': 'erase',
        'evidence.topic_contributions': 'erase',
        'evidence.activity_current': 'erase',
        'evidence.activity_revisions': 'erase',
        'evidence.topic_context': 'erase',
        'evidence.encounter_evidence': 'erase',
        'evidence.observations': 'erase',
        'evidence.action_events': 'erase',
        'store:pgboss/evidence.apply-action': 'erase',
        'store:pgboss/evidence.project-scroll-reading': 'erase',
        'store:pgboss/evidence.project-encounter-activity': 'erase',
      },
    },
    {
      module: 'experience',
      personalTables: [
        {
          table: 'experience.recording_channel_certificates',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.recording_segment_inputs',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.recording_segments',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.recording_offer_origins',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.recording_command_origins',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.action_links',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.action_state',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.navigation_transitions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.offer_activations',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.offer_region_constraints',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.offers',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.sessions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.encounter_activity_inputs',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.encounter_lineage',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.saved_places',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.saved_items',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.actions',
          ownerColumn: 'universe_id',
        },
        {
          table: 'experience.exposures',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: [],
      clearDispositions: {
        'experience.recording_channel_certificates': 'erase',
        'experience.recording_segment_inputs': 'erase',
        'experience.recording_segments': 'erase',
        'experience.recording_offer_origins': 'erase',
        'experience.recording_command_origins': 'erase',
        'experience.action_links': 'erase',
        'experience.action_state': 'erase',
        'experience.navigation_transitions': 'erase',
        'experience.offer_activations': 'erase',
        'experience.offer_region_constraints': 'erase',
        'experience.offers': 'erase',
        'experience.sessions': 'erase',
        'experience.encounter_activity_inputs': 'erase',
        'experience.encounter_lineage': 'erase',
        'experience.saved_places': 'preserve',
        'experience.saved_items': 'preserve',
        'experience.actions': 'erase',
        'experience.exposures': 'erase',
      },
    },
    {
      module: 'composer',
      personalTables: [
        {
          table: 'composer.decisions',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [],
      nonRowStores: [],
      clearDispositions: {
        'composer.decisions': 'erase',
      },
    },
    {
      module: 'reasoning',
      personalTables: [
        {
          table: 'reasoning.protected_requests',
          ownerColumn: 'universe_id',
        },
        {
          table: 'reasoning.external_attempts',
          ownerColumn: 'universe_id',
        },
        {
          table: 'reasoning.business_runs',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [
        {
          table: 'reasoning.business_runs',
          column: 'recording_account_id',
        },
      ],
      nonRowStores: ['minimax/request-copies'],
      clearDispositions: {
        'reasoning.protected_requests': 'erase',
        'reasoning.external_attempts': 'redact_accounting',
        'reasoning.business_runs': 'redact_accounting',
        'store:minimax/request-copies': 'external_retention',
      },
    },
    {
      module: 'receipts',
      personalTables: [
        {
          table: 'receipts.personal_commands',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [],
      accountColumns: [
        {
          table: 'receipts.shared_commands',
          column: 'actor_account_id',
        },
      ],
      nonRowStores: [],
      clearDispositions: {
        'receipts.personal_commands': 'erase',
        'receipts.shared_commands': 'preserve',
      },
    },
    {
      module: 'identity',
      personalTables: [
        {
          table: 'identity.recording_lifecycle_witnesses',
          ownerColumn: 'universe_id',
        },
      ],
      accountTables: [
        {
          table: 'identity.recording_lifecycle_witnesses',
          ownerColumn: 'account_id',
        },
        {
          table: 'identity.recording_commands',
          ownerColumn: 'account_id',
        },
        {
          table: 'identity.email_addresses',
          ownerColumn: 'account_id',
        },
        {
          table: 'identity.sign_in_links',
          ownerColumn: 'address',
        },
        {
          table: 'identity.sessions',
          ownerColumn: 'account_id',
        },
        {
          table: 'identity.clear_operations',
          ownerColumn: 'account_id',
        },
        {
          table: 'identity.clear_liabilities',
          ownerColumn: 'account_id',
        },
      ],
      accountColumns: [
        {
          table: 'ops.operator_sign_ins',
          column: 'account_id',
        },
      ],
      nonRowStores: [
        'pgboss/identity.recover-clear-operations',
        'pgboss/identity.clear-exploration',
        'agentmail/sent-sign-in-mail',
      ],
      clearDispositions: {
        'identity.recording_lifecycle_witnesses': 'erase',
        'identity.recording_commands': 'preserve',
        'identity.email_addresses': 'preserve',
        'identity.sign_in_links': 'preserve',
        'identity.sessions': 'preserve',
        'identity.clear_operations': 'preserve',
        'identity.clear_liabilities': 'preserve',
        'ops.operator_sign_ins': 'preserve',
        'store:pgboss/identity.recover-clear-operations': 'preserve',
        'store:pgboss/identity.clear-exploration': 'preserve',
        'store:agentmail/sent-sign-in-mail': 'external_retention',
      },
    },
  ],
  root: {
    table: 'identity.universes',
    modeColumn: 'recording_lifecycle_protocol',
    mode: 1,
    epochColumn: 'privacy_epoch',
    ownerColumn: 'account_id',
    barrierColumn: 'clear_operation_id',
    birth: 'actual-universe-insert',
    clear: 'verified-current-core-before-barrier-release',
    financialCompletion: 'independent',
  },
  certificates: {
    table: 'experience.recording_channel_certificates',
    channels: ['saved', 'liked'],
    empty: 'first_decision_action_id-is-null-and-actual-pointer-is-null',
    tracked: 'first-real-eligible-decision-with-immutable-initializing-action',
    scope: 'root-own-account-once-original-generation-current-epoch',
    positive: 'authoritative-necessary-changed-only',
    negative: 'actual-eligible-negative-may-correct-tracked-origin',
    effectOrder: 'old-origin-capture-pointer-and-certificate-CAS-before-required-group-effects',
    maxExposures: 2,
    rootMaterialRevisionsPerGroup: 1,
    producerNoticesPerGroup: 1,
  },
  writers: [
    {
      owner: 'experience',
      operations: ['experience.apply-action', 'experience.encounter-action-v0', 'experience.keep-entry-remove'],
      requires: [
        'immutable-original-wire-generation',
        'actual-receipt-operation-action-link',
        'required-real-recording-effects',
        'current-fresh-lifecycle',
        'independent-channel-certificate',
        'no-legacy-fallback-in-fresh-mode',
      ],
    },
    {
      owner: 'experience',
      operations: [
        'experience.activate-exposure',
        'experience.activate-offer-v0',
        'experience.compose-open-v0',
        'experience.navigate-v0',
        'experience.region-open-v1',
      ],
      requires: [
        'intent-and-activation-same-original-generation',
        'immutable-pinned-attribution',
        'actual-activation-session-not-evidence',
        'no-necessary-flag-to-channel-credit',
      ],
    },
    {
      owner: 'evidence',
      operations: [
        'intake',
        'project-scroll-reading',
        'project-encounter-activity',
        'apply-action-evidence',
        'explicit-reconcile',
      ],
      requires: [
        'genuine-current-original-generation-capability',
        'exact-current-segment-and-session',
        'certificate-pointer-positive-and-negative-origin-validation',
        'sealed-committed-baseline-no-raw-generation-union',
        'required-four-method-PC-effect-and-both-material-role-owners',
      ],
    },
    {
      owner: 'personal-context',
      operations: ['recording-structural-projection', 'recording-coverage-projection', 'trusted-coverage-read'],
      requires: [
        'own-committed-baseline-and-current-segment-Q',
        'no-Evidence-aggregate-Q-as-absent-PC-seed',
        'composite-exposure-generation-QID-activityID-certificateSHA',
        'bounded-raw-prefix-before-dedup-and-after-Content-waits',
      ],
    },
    {
      owner: 'planner-geography',
      operations: ['material-change', 'request', 'prepare', 'context-capture', 'dispatch', 'retry', 'apply'],
      requires: [
        'original-source-generation',
        'actual-owner-proof-before-private-context-and-ledger',
        'same-genuine-cap-material-change',
        'accounting-independently-payload-free-while-paused',
      ],
    },
  ],
  queuePayloadErasure: {
    ordinaryStates: 'all-states-in-pgboss.job',
    pairedDeadLetterSuffix: '.dead',
    claimedInMemory: 'old-epoch-original-generation-recheck-before-any-private-read-or-effect',
  },
  rollout: {
    oldBinaries: 'stop-and-replace-before-fresh-production-root-election',
    mixedVersionAggregateSandbox: false,
    legacyUnknown: 'preserve-credit-and-refuse-certification-no-history-scan-or-backfill',
    ownerClear: 'never-automatic',
    activation: 'separate-source-review-current-Actions-real-DI-and-process-election',
  },
} as const;
const registryLiteral = (registry: readonly ModuleErasure[]) =>
  registry.map((d) => ({
    module: d.module,
    personalTables: d.tables.map((t) => ({ table: `${t.schema}.${t.table}`, ownerColumn: t.ownerColumn })),
    accountTables: (d.accountTables ?? []).map((t) => ({
      table: `${t.schema}.${t.table}`,
      ownerColumn: t.ownerColumn,
    })),
    accountColumns: (d.accountColumns ?? []).map((t) => ({ table: `${t.schema}.${t.table}`, column: t.column })),
    nonRowStores: d.nonRowStores.map((t) => t.name),
    clearDispositions: d.clearExploration!.dispositions,
  }));
function assertCurrentRegistry(): void {
  if (
    createHash('sha256').update(canonicalJson(currentRecordingProtocol)).digest('hex') !==
      RECORDING_LIFECYCLE_PROTOCOL_SHA256 ||
    canonicalJson(registryLiteral(explorationStores)) !== canonicalJson(currentRecordingProtocol.registry)
  )
    throw new Error('CLEAR_CURRENT_PROTOCOL_MISMATCH');
}
// Freeze the actual imported callbacks and declarations after their owning modules initialized.
// A generic registry made from lookalike callbacks never acquires the current-proof brand.
for (const d of [...personalStores, ...explorationStores]) {
  for (const values of [d.tables, d.accountTables ?? [], d.accountColumns ?? [], d.nonRowStores]) {
    for (const value of values) Object.freeze(value);
    Object.freeze(values);
  }
  if (d.clearExploration) {
    Object.freeze(d.clearExploration.dispositions);
    Object.freeze(d.clearExploration);
  }
  Object.freeze(d);
}
Object.freeze(personalStores);
assertCurrentRegistry();
/** Sole closed current runner. No caller-provided registry, callback, version or digest. */
export async function eraseCurrentExploration(scope: ClearCoreTx): Promise<void> {
  assertCurrentRegistry();
  await eraseExploration(scope, explorationStores);
  assertCurrentRegistry();
  markCurrentClearRemovalVerified(scope);
}
