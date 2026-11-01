import {
  CHECK_ACTIVATED_EXPOSURE,
  READ_BUFFER_SOURCE,
  READ_HIDDEN_ASSETS,
  type CheckActivatedExposure,
  type ReadBufferSource,
  type ReadHiddenAssets,
} from '../../composer/public.js';
import { readHidden, readMember, readSession } from './navigation-store.js';
import { readNotInterested } from './not-interested-store.js';
import { readExposure } from './postgres-store.js';

/** Whether the exposure exists in the scope's epoch and was activated: what Jev's owner check needs to know of a buffer job. */
const checkActivatedExposure: CheckActivatedExposure = async (scope, exposureId) => {
  const exposure = await readExposure(scope, exposureId);
  return exposure !== undefined && exposure.activatedAt !== undefined && exposure.privacyEpoch === scope.authority.privacyEpoch;
};

/** Tells the Composer buffer worker about an offer, only if it was really activated at this exposure. */
const readBufferSource: ReadBufferSource = async (scope, { sessionId, offerId, exposureId }) => {
  const member = await readMember(scope, sessionId, offerId, exposureId);
  const session = member ? await readSession(scope, sessionId) : undefined;
  if (!member || !session) return undefined;
  return {
    intentRevision: session.intentRevision,
    capabilities: session.capabilities,
    source: { assetId: member.offer.descriptor.assetId, assetRevision: member.offer.descriptor.assetRevision },
    regionScoped: member.offer.regionConstraint !== undefined,
  };
};

/** A buffer serves a subject move, which names no target, so it leaves out Hide and "Not interested" (D-055). */
const readHiddenAssets: ReadHiddenAssets = async (scope, assetIds) => [
  ...new Set([...(await readHidden(scope, assetIds)), ...(await readNotInterested(scope, assetIds))]),
];

/** Experience's answers to the Composer buffer worker: read-only views of sessions, activations, Hide and Not interested. */
export function experienceBufferSourceProviders() {
  return [
    { provide: READ_BUFFER_SOURCE, useValue: readBufferSource },
    { provide: READ_HIDDEN_ASSETS, useValue: readHiddenAssets },
    { provide: CHECK_ACTIVATED_EXPOSURE, useValue: checkActivatedExposure },
  ];
}
