import { readGeographyContract, readUniverseDeltasContract } from './geography.js';
import { mediaGrantContract } from './media.js';
import { cancelContentRequestContract, createContentRequestContract, readContentRequestContract } from './supply.js';
import { exposureContextContract, navigateExperienceContract } from './navigation.js';
import {
  activateExposureContract,
  applyActionContract,
  exposureDocumentContract,
  listSavedContract,
  openExposureContract,
} from './experience.js';
import { healthContract } from './health.js';
import {
  peekSignInContract,
  redeemSignInContract,
  requestSignInContract,
  sessionContract,
  signOutContract,
} from './identity.js';
import { evidenceDiagnosticsContract, submitObservationsContract } from './interactions.js';

/** The complete HTTP contract of the KnowScroll API. Every route the API serves is listed here. */
export const apiContract = {
  health: healthContract,
  geography: { read: readGeographyContract, deltas: readUniverseDeltasContract },
  media: { grant: mediaGrantContract },
  supply: {
    create: createContentRequestContract,
    read: readContentRequestContract,
    cancel: cancelContentRequestContract,
  },
  identity: {
    requestSignIn: requestSignInContract,
    peekSignIn: peekSignInContract,
    redeemSignIn: redeemSignInContract,
    session: sessionContract,
    signOut: signOutContract,
  },
  experience: {
    applyAction: applyActionContract,
    listSaved: listSavedContract,
    openExposure: openExposureContract,
    navigate: navigateExperienceContract,
    activateExposure: activateExposureContract,
    exposureDocument: exposureDocumentContract,
    exposureContext: exposureContextContract,
  },
  observations: {
    submit: submitObservationsContract,
  },
  diagnostics: {
    evidence: evidenceDiagnosticsContract,
  },
};

export type ApiContract = typeof apiContract;
