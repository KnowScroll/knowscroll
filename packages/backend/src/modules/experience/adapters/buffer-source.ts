import {
  CHECK_RECORDED_ACTIVATION,
  READ_BUFFER_SOURCE,
  READ_HIDDEN_ASSETS,
  type CheckRecordedActivation,
  type ReadBufferSource,
  type ReadHiddenAssets,
} from '../../composer/public.js';
import { readHidden, readMember, readSession } from './navigation-store.js';
import { readNotInterested } from './not-interested-store.js';
import { activatedWhileRecording } from './recording-store.js';

/** See `CheckRecordedActivation`: what Jev's owner check needs to know of the exposure a buffer job was made for. */
const checkRecordedActivation: CheckRecordedActivation = activatedWhileRecording;

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
    { provide: CHECK_RECORDED_ACTIVATION, useValue: checkRecordedActivation },
  ];
}
