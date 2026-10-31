import {
  composeEncounter,
  COMPOSE_ENCOUNTER,
  PERSIST_COMPOSER_DECISION,
  READ_COMPOSER_DECISION,
  type ComposerOperatorAccess,
} from '../public.js';
import { makeComposerStore } from './postgres-store.js';
/** Composition only: access must be the authenticated operator allowlist, never client input. */
export function composerProviders(access: ComposerOperatorAccess) {
  const store = makeComposerStore(access);
  return [
    { provide: COMPOSE_ENCOUNTER, useValue: composeEncounter },
    { provide: PERSIST_COMPOSER_DECISION, useValue: store.persistComposerDecision },
    { provide: READ_COMPOSER_DECISION, useValue: store.readComposerDecision },
  ];
}
export { makeComposerStore } from './postgres-store.js';
export { composerBufferProviders, composerBufferWorkerProviders } from './buffer-providers.js';
export { composerBufferStore } from './buffer-store.js';
export { jevPoolStore } from './jev-pool-store.js';
export { readRetainedDecisions } from './replay-store.js';
