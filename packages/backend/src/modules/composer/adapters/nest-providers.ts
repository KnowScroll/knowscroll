import {
  composeEncounter,
  composerPolicyFor,
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  READ_COMPOSER_DECISION,
  type ComposerOperatorAccess,
  type ComposerPolicySetting,
  type ComposeEncounter,
  type PersistComposerDecision,
  type RecordDecisionSignals,
} from '../public.js';
import type { LogEvent } from '../../../infrastructure/observability/index.js';
import { makeComposerStore } from './postgres-store.js';
import { withGapSignals } from './gap-signal-persist.js';
const composeUnder = (setting: ComposerPolicySetting): ComposeEncounter => {
  const policy = composerPolicyFor(setting);
  return Object.assign((snapshot: Parameters<ComposeEncounter>[0]) => composeEncounter(snapshot, policy), { policy });
};

function storeProviders(access: ComposerOperatorAccess) {
  const store = makeComposerStore(access);
  return [
    { provide: PERSIST_COMPOSER_DECISION, useValue: store.persistComposerDecision },
    { provide: READ_COMPOSER_DECISION, useValue: store.readComposerDecision },
  ];
}

/**
 * The same store with the signals a committed decision carries recorded in the same transaction (#674, D-414). `gapSignals` names the
 * token of the recorder (Supply's `RECORD_GAP_SIGNALS`): the composition root passes it where the gap loop runs, and the decision is
 * stored exactly as before.
 */
function recordingStoreProviders(access: ComposerOperatorAccess, gapSignals: symbol, logEvent: symbol) {
  const store = makeComposerStore(access);
  return [
    {
      provide: PERSIST_COMPOSER_DECISION,
      inject: [gapSignals, logEvent],
      useFactory: (record: RecordDecisionSignals, log: LogEvent): PersistComposerDecision =>
        withGapSignals(store.persistComposerDecision, record, {
          onFailure: (code) => log('composer.gap_signal_failed', { reasonCode: code }),
        }),
    },
    { provide: READ_COMPOSER_DECISION, useValue: store.readComposerDecision },
  ];
}

/**
 * Composer under a fixed policy setting (`v0` unless a test names `v1`). Composition only: access must be the
 * authenticated operator allowlist, never client input.
 */
export function composerProviders(access: ComposerOperatorAccess, setting: ComposerPolicySetting = 'v0') {
  return [{ provide: COMPOSE_ENCOUNTER, useValue: composeUnder(setting) }, ...storeProviders(access)];
}

/**
 * Composer under the policy the process is configured for: `config` is the token of its configuration, whose
 * `composerPolicy` is `KS_COMPOSER_POLICY` (`v0` unless set, D-190). New decisions are made under that policy; a stored
 * decision replays under its own either way.
 */
export function composerConfiguredProviders(access: ComposerOperatorAccess, config: symbol) {
  return [configuredCompose(config), ...storeProviders(access)];
}

/**
 * {@link composerConfiguredProviders} for a process where the gap loop runs (#674, D-414): the decision is stored exactly as before and
 * the signals it carries (a last resort, the last unseen explanation of a topic) are recorded in the same transaction by
 * `gapSignals`, the token of Supply's recorder, as a best effort that can neither fail nor delay the navigation (a failure is logged by code
 * through `logEvent`, the token of the process's event log). Composition roots only.
 */
export function composerRecordingProviders(
  access: ComposerOperatorAccess,
  config: symbol,
  gapSignals: symbol,
  logEvent: symbol,
) {
  return [configuredCompose(config), ...recordingStoreProviders(access, gapSignals, logEvent)];
}

const configuredCompose = (config: symbol) => ({
  provide: COMPOSE_ENCOUNTER,
  inject: [config],
  useFactory: (settings: { readonly composerPolicy: ComposerPolicySetting }) => composeUnder(settings.composerPolicy),
});
export { makeComposerStore } from './postgres-store.js';
export { withGapSignals } from './gap-signal-persist.js';
export {
  composerBufferProviders,
  composerBufferWorkerProviders,
  composerRecordingOwnerProviders,
} from './buffer-providers.js';
export { composerPruneBackfill, composerPruneProviders } from './prune-providers.js';
export { composerBufferStore } from './buffer-store.js';
export { jevPoolStore } from './jev-pool-store.js';
export { readRetainedDecisions } from './replay-store.js';
