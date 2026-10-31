import {
  composeEncounter,
  composerPolicyFor,
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  READ_COMPOSER_DECISION,
  type ComposerOperatorAccess,
  type ComposerPolicySetting,
  type ComposeEncounter,
} from '../public.js';
import { makeComposerStore } from './postgres-store.js';
const composeUnder =
  (setting: ComposerPolicySetting): ComposeEncounter =>
  (snapshot) =>
    composeEncounter(snapshot, composerPolicyFor(setting));

function storeProviders(access: ComposerOperatorAccess) {
  const store = makeComposerStore(access);
  return [
    { provide: PERSIST_COMPOSER_DECISION, useValue: store.persistComposerDecision },
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
  return [
    {
      provide: COMPOSE_ENCOUNTER,
      inject: [config],
      useFactory: (settings: { readonly composerPolicy: ComposerPolicySetting }) =>
        composeUnder(settings.composerPolicy),
    },
    ...storeProviders(access),
  ];
}
export { makeComposerStore } from './postgres-store.js';
export { composerBufferProviders, composerBufferWorkerProviders } from './buffer-providers.js';
export { composerBufferStore } from './buffer-store.js';
export { jevPoolStore } from './jev-pool-store.js';
export { readRetainedDecisions } from './replay-store.js';
