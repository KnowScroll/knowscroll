import {
  CHECK_ASSET_AUDIENCE,
  FIND_ASSET_FOR_ACTION,
  type CheckAssetAudience,
  type FindAssetForAction,
} from '../../content/public.js';
import { FENCE_OWN_ACCOUNT, type FenceOwnAccount, type WithPersonalScope } from '../../identity/public.js';
import {
  completePersonalReceipt,
  findPersonalReceipt,
  insertPersonalReceipt,
  requestHash,
} from '../../../infrastructure/receipts/index.js';
import { makeSetNotInterested, makeUndoNotInterested } from '../application/not-interested.js';
import { NOT_INTERESTED_USE_CASES, type NotInterestedUseCases } from '../public.js';
import { gateFindAsset } from './audience-gate.js';
import { notInterestedStore } from './not-interested-store.js';
import { withExperienceScope } from './recording-store.js';

/** "Not interested" over PostgreSQL: the receipt store, the audience-gated asset read and the table. */
export function notInterestedUseCases(deps: {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly findAsset: FindAssetForAction;
  readonly audience: CheckAssetAudience;
}): NotInterestedUseCases {
  const ports = {
    withPersonalScope: withExperienceScope(deps.withScope, deps.fenceOwn),
    hashRequest: requestHash,
    findReceipt: findPersonalReceipt,
    insertReceipt: insertPersonalReceipt,
    completeReceipt: completePersonalReceipt,
    findAsset: gateFindAsset(deps.findAsset, deps.audience),
    store: notInterestedStore,
  };
  return { set: makeSetNotInterested(ports), undo: makeUndoNotInterested(ports) };
}

export function notInterestedProviders(tokens: { readonly withPersonalScope: symbol }) {
  return [
    {
      provide: NOT_INTERESTED_USE_CASES,
      inject: [tokens.withPersonalScope, FENCE_OWN_ACCOUNT, FIND_ASSET_FOR_ACTION, CHECK_ASSET_AUDIENCE],
      useFactory: (
        withScope: WithPersonalScope,
        fenceOwn: FenceOwnAccount,
        findAsset: FindAssetForAction,
        audience: CheckAssetAudience,
      ) => notInterestedUseCases({ withScope, fenceOwn, findAsset, audience }),
    },
  ];
}
