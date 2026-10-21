import type { FenceAccountPair, FenceOwnAccount, WithPersonalScope } from '../../identity/public.js';
import { FENCE_ACCOUNT_PAIR, FENCE_OWN_ACCOUNT } from '../../identity/public.js';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import { makeReadProfile, makeSetProfile } from '../application/profiles.js';
import { makeLookupPerson, makeReadPair } from '../application/lookup-person.js';
import { makePairCommand } from '../application/pairs.js';
import { SOCIAL_USE_CASES, type SocialUseCases } from '../public.js';
import { socialStore } from './postgres-store.js';
import type { SocialPorts } from '../application/ports.js';
/** Explicitly constructed by tests/future composition; currently mounted nowhere. */
export function socialUseCases(deps: {
  withScope: WithPersonalScope;
  fencePair: FenceAccountPair;
  fenceOwn: FenceOwnAccount;
  now?: () => Date;
  newId?: () => string;
  store?: SocialPorts['store'];
}): SocialUseCases {
  const ports: SocialPorts = {
    ...deps,
    store: deps.store ?? socialStore,
    newId: deps.newId ?? uuidv7,
    now: deps.now ?? (() => new Date()),
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
  };
  return {
    readProfile: makeReadProfile(ports),
    setProfile: makeSetProfile(ports),
    lookup: makeLookupPerson(ports),
    readPair: makeReadPair(ports),
    command: makePairCommand(ports),
  };
}
export function socialProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: SOCIAL_USE_CASES,
      inject: [tokens.withPersonalScope, FENCE_ACCOUNT_PAIR, FENCE_OWN_ACCOUNT],
      useFactory: (withScope: WithPersonalScope, fencePair: FenceAccountPair, fenceOwn: FenceOwnAccount) =>
        socialUseCases({ withScope, fencePair, fenceOwn }),
    },
  ];
}
export { socialStore, privatePairId } from './postgres-store.js';
export type { SocialPorts } from '../application/ports.js';
