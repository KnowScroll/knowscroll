import {
  READ_BUFFER_SOURCE,
  READ_HIDDEN_ASSETS,
  type ReadBufferSource,
  type ReadHiddenAssets,
} from '../../composer/public.js';
import { readHidden, readMember, readSession } from './navigation-store.js';

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

const readHiddenAssets: ReadHiddenAssets = (scope, assetIds) => readHidden(scope, assetIds);

/** Experience's answers to the Composer buffer worker: read-only views of sessions, activations and Hide. */
export function experienceBufferSourceProviders() {
  return [
    { provide: READ_BUFFER_SOURCE, useValue: readBufferSource },
    { provide: READ_HIDDEN_ASSETS, useValue: readHiddenAssets },
  ];
}
