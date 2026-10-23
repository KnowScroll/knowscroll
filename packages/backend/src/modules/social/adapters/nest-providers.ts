import { createHash, randomBytes } from 'node:crypto';
import { makeReadRoster } from '../application/rosters.js';
import { makeInvites } from '../application/invites.js';
import { rosterStore } from './postgres-rosters.js';
import { inviteStore } from './postgres-invites.js';
import { rosterCursorCodec } from './roster-cursor.js';
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
/** Explicit backend use cases; only composition roots choose crypto and database adapters. */
export function socialUseCases(deps: {
  withScope: WithPersonalScope;
  fencePair: FenceAccountPair;
  fenceOwn: FenceOwnAccount;
  now?: () => Date;
  newId?: () => string;
  store?: SocialPorts['store'];
  cursor?: SocialPorts['cursor'];
}): SocialUseCases {
  const ports: SocialPorts = {
    ...deps,
    invites: inviteStore,
    rosters: rosterStore,
    cursor: deps.cursor ?? rosterCursorCodec(),
    secret: () => `ksfi_${randomBytes(32).toString('base64url')}`,
    digest: (secret) => createHash('sha256').update(secret).digest('hex'),
    store: deps.store ?? socialStore,
    newId: deps.newId ?? uuidv7,
    now: deps.now ?? (() => new Date()),
    hash: (operation, input) => requestHash(operation, input as CanonicalJson),
  };
  return {
    ...makeInvites(ports),
    readFriends: makeReadRoster(ports, false),
    readRequests: makeReadRoster(ports, true),
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
